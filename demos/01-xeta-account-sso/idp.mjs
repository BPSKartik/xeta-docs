// The identity provider: accounts, the IdP's own sign-in session, and the two
// OAuth-lite endpoints (authorize, token). Maps stand in for database tables.

import crypto from "node:crypto";
import { json, redirect } from "./web.mjs";

export const CODE_TTL_MS = 5 * 60 * 1000; // a redirect plus one server call, with room to spare
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "idp_session";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("hex");

// Node's built-in scrypt, so the demo has no dependencies.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return { salt, hash: crypto.scryptSync(password, salt, 32) };
}
const passwordMatches = (password, stored) =>
  crypto.timingSafeEqual(crypto.scryptSync(password, stored.salt, 32), stored.hash);

// timingSafeEqual takes the same time wherever the first wrong byte is, so
// response times can't be used to guess a secret one byte at a time. It throws
// on unequal lengths, so lengths are compared first; that reveals the length,
// nothing else.
export function secretMatches(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Where to go after signing in: same-origin paths only. Browsers read "//x"
// and "/\x" as another host, so those are refused along with full URLs.
export function safeNext(next) {
  if (typeof next !== "string" || !next.startsWith("/")) return null;
  if (next.startsWith("//") || next.includes("\\")) return null;
  return next;
}

// claim: "conditional" is the design. "check-then-set" exists only so the demo
// can show what goes wrong without it.
export function createIdp({ origin, clients, now, claim = "conditional" }) {
  const users = new Map(); // id -> { id, name, email, password }
  const sessions = new Map(); // sha256(token) -> { userId, expiresAt }
  const codes = new Map(); // sha256(code) -> { clientId, userId, redirectUri, expiresAt, redeemedAt }
  const registry = new Map(clients.map((c) => [c.id, c]));

  // Every table access waits a tick first, like a round trip to a database.
  // Two requests can interleave in that gap, and that is where races live.
  const db = async (fn) => {
    await new Promise((resolve) => setImmediate(resolve));
    return fn();
  };

  const profile = (u) => (u ? { id: u.id, name: u.name, email: u.email } : null);
  const findByEmail = (email) => [...users.values()].find((u) => u.email === email) ?? null;
  const afterSignIn = (next) => safeNext(next) ?? "/hub";

  // ── The IdP's own session ──────────────────────────────────────────────────

  async function startSession(userId) {
    const token = randomToken();
    // Only the hash is stored: a leaked copy of this table is not a pile of
    // working cookies. (A real deployment also sets httpOnly, SameSite=Lax and Secure.)
    await db(() => sessions.set(sha256(token), { userId, expiresAt: now() + SESSION_TTL_MS }));
    return { [SESSION_COOKIE]: token };
  }

  async function sessionUser(cookies) {
    const token = cookies[SESSION_COOKIE];
    if (!token) return null;
    const s = await db(() => sessions.get(sha256(token)));
    if (!s || s.expiresAt <= now()) return null;
    return users.get(s.userId) ?? null;
  }

  async function signup({ name = "", email = "", password = "", next } = {}) {
    name = String(name).trim();
    email = String(email).trim().toLowerCase();
    if (!name || !EMAIL_RE.test(email) || String(password).length < 8) return json(400, { error: "invalid details" });
    if (await db(() => findByEmail(email))) return json(409, { error: "account exists" });
    const user = { id: `xeta-user-${users.size + 1}`, name, email, password: hashPassword(String(password)) };
    await db(() => users.set(user.id, user));
    return redirect(afterSignIn(next), await startSession(user.id));
  }

  async function login({ email = "", password = "", next } = {}) {
    const user = await db(() => findByEmail(String(email).trim().toLowerCase()));
    // One answer for "no such email" and "wrong password".
    if (!user || !passwordMatches(String(password), user.password)) {
      return json(401, { error: "incorrect email or password" });
    }
    return redirect(afterSignIn(next), await startSession(user.id));
  }

  async function logout(cookies) {
    const token = cookies[SESSION_COOKIE];
    if (token) await db(() => sessions.delete(sha256(token)));
    return json(200, { ok: true }, { [SESSION_COOKIE]: null });
  }

  async function accountPage(url, cookies) {
    const next = url.searchParams.get("next");
    if (await sessionUser(cookies)) return redirect(afterSignIn(next));
    // In a real IdP this is the sign-in form; it posts back with `next`.
    return json(200, { page: "sign-in", continue: url.searchParams.get("continue"), next });
  }

  // ── Codes: random, stored hashed, five minutes, one use ────────────────────

  async function issueCode({ clientId, userId, redirectUri }) {
    const code = randomToken();
    await db(() =>
      codes.set(sha256(code), { clientId, userId, redirectUri, expiresAt: now() + CODE_TTL_MS, redeemedAt: null }),
    );
    return code;
  }

  async function redeemCode({ code, clientId, redirectUri }) {
    const key = sha256(code);
    const row = await db(() => {
      const r = codes.get(key);
      return r && { ...r }; // a read returns a snapshot, as a SELECT would
    });
    if (!row || row.redeemedAt !== null || row.expiresAt <= now()) return null;
    // A code only works for the client and the redirect URI it was issued for.
    if (row.clientId !== clientId || row.redirectUri !== redirectUri) return null;

    // By now the snapshot above may be stale: a second request with the same
    // code can have read "unused" too. So the claim is a conditional write,
    // "set redeemedAt where redeemedAt is still null", and only the request whose
    // write matched a row wins.
    const won =
      claim === "conditional"
        ? await db(() => {
            const r = codes.get(key);
            if (r.redeemedAt !== null) return false;
            r.redeemedAt = now();
            return true;
          })
        : await db(() => {
            codes.get(key).redeemedAt = now(); // check-then-set: trusts the stale read
            return true;
          });
    if (!won) return null;
    return db(() => users.get(row.userId));
  }

  // ── GET /authorize ───────────────────────────────────────────────

  async function authorize(url, cookies) {
    const q = url.searchParams;
    const client = registry.get(q.get("client_id") ?? "");
    if (!client) return json(400, { error: "unknown client" });
    const redirectUri = q.get("redirect_uri") ?? "";
    // Exact string match against the client's list, checked before anything
    // else. On failure we answer here instead of redirecting: an unlisted URI
    // is exactly where nothing, not even an error, should be sent.
    if (!client.redirectUris.includes(redirectUri)) return json(400, { error: "redirect_uri not allowed" });

    const user = await sessionUser(cookies);
    if (!user) {
      // Sign in first, then come back to this same authorize URL.
      const login = new URL("/sign-in", origin);
      login.searchParams.set("continue", client.id);
      login.searchParams.set("next", url.pathname + url.search);
      return redirect(login);
    }

    // First-party clients only, so no consent screen: straight back with a code.
    const code = await issueCode({ clientId: client.id, userId: user.id, redirectUri });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    const state = q.get("state");
    if (state) back.searchParams.set("state", state);
    return redirect(back);
  }

  // ── POST /token (server to server) ───────────────────────────────

  async function token(body = {}) {
    const client = registry.get(String(body.client_id ?? ""));
    if (!client) return json(400, { error: "unknown client" });
    // No secret configured means refuse everyone, never "accept anything".
    if (!client.secret) return json(503, { error: "client not configured" });
    if (!secretMatches(String(body.client_secret ?? ""), client.secret)) {
      return json(401, { error: "invalid client secret" });
    }
    const user = await redeemCode({
      code: String(body.code ?? ""),
      clientId: client.id,
      redirectUri: String(body.redirect_uri ?? ""),
    });
    if (!user) return json(400, { error: "invalid or expired code" });
    // The "lite" part: no access or refresh token. The profile is the answer,
    // and the app starts its own session from it.
    return json(200, { ok: true, user: profile(user) });
  }

  async function handle({ method, url, cookies, body }) {
    switch (`${method} ${url.pathname}`) {
      case "POST /signup": return signup(body);
      case "POST /login": return login(body);
      case "POST /logout": return logout(cookies);
      case "GET /me": return json(200, { user: profile(await sessionUser(cookies)) });
      case "GET /sign-in": return accountPage(url, cookies);
      case "GET /hub": return json(200, { page: "account hub", user: profile(await sessionUser(cookies)) });
      case "GET /authorize": return authorize(url, cookies);
      case "POST /token": return token(body);
      default: return json(404, { error: "not found" });
    }
  }

  return { origin, handle, tables: { users, sessions, codes } };
}
