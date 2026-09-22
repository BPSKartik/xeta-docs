// An app with a "Continue with Xeta" button. Two flavours, one for each way an
// app can relate to the IdP:
//   sharedUsers given -> the app reads the IdP's own user table (shared database)
//   sharedUsers null  -> the app has its own table and links by email (separate database)

import crypto from "node:crypto";
import { json, redirect } from "./web.mjs";

const STATE_COOKIE = "oauth_state";

export function createConsumerApp({ web, name, origin, clientId, secret, idpOrigin, sharedUsers = null }) {
  const callbackUri = `${origin}/callback`;
  const SESSION_COOKIE = `${clientId}_session`;
  const ownUsers = new Map(); // only used when there is no shared table
  const sessions = new Map(); // this app's own sessions: token -> userId (simplified)
  const users = sharedUsers ?? ownUsers;

  // GET /start
  function start() {
    // `state` ties the callback to this browser. Without it, someone could
    // send you a callback link carrying a code for THEIR account, and you
    // would be signed in as them without noticing.
    const state = crypto.randomBytes(16).toString("hex");
    const auth = new URL("/authorize", idpOrigin);
    auth.searchParams.set("client_id", clientId);
    auth.searchParams.set("redirect_uri", callbackUri);
    auth.searchParams.set("state", state);
    return redirect(auth, { [STATE_COOKIE]: state });
  }

  // GET /callback?code&state
  async function callback(url, cookies) {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const fail = (why) => redirect(`/sign-in?error=${encodeURIComponent(why)}`, { [STATE_COOKIE]: null });
    if (!code || !state || state !== cookies[STATE_COOKIE]) return fail("state mismatch");

    // Server to server, with the secret. The browser carried only the code;
    // it never sees the secret or the profile.
    const res = await web.backChannel(`${idpOrigin}/token`, {
      client_id: clientId,
      client_secret: secret,
      code,
      redirect_uri: callbackUri,
    });
    if (res.status !== 200 || !res.data?.user?.id) return fail(res.data?.error ?? "token exchange failed");

    const user = sharedUsers ? findShared(res.data.user) : linkByEmail(res.data.user);
    if (!user) return fail("no account here for this Xeta user");

    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, user.id);
    return redirect("/home", { [STATE_COOKIE]: null, [SESSION_COOKIE]: token });
  }

  // Same database: the IdP's user id IS this app's user id. Look the row up
  // and never create one; any user the IdP knows is already a row here.
  function findShared(profile) {
    return sharedUsers.get(profile.id) ?? null;
  }

  // Own database: the IdP's id means nothing here, so the email address is the
  // join key. Find the local account with that address, or create one on first
  // sign-in, with no local password (it signs in through the IdP).
  // The trade-off: the IdP's email claim now decides which local account you
  // get, so linking is only as trustworthy as the IdP's knowledge that the
  // user owns that address.
  function linkByEmail(profile) {
    const email = String(profile.email).toLowerCase();
    for (const u of ownUsers.values()) if (u.email === email) return u;
    const u = { id: `${clientId}-user-${ownUsers.size + 1}`, email, name: profile.name, handle: uniqueHandle(email) };
    ownUsers.set(u.id, u);
    return u;
  }

  // Handles are unique here, so derive one from the email and add a suffix on
  // a clash (a counter keeps the demo output stable).
  function uniqueHandle(email) {
    const base = email.split("@")[0].replace(/[^a-z0-9_.]/g, "") || "user";
    const taken = (h) => [...ownUsers.values()].some((u) => u.handle === h);
    let handle = base;
    for (let n = 2; taken(handle); n++) handle = `${base}${n}`;
    return handle;
  }

  async function handle({ method, url, cookies }) {
    switch (`${method} ${url.pathname}`) {
      case "GET /start": return start();
      case "GET /callback": return callback(url, cookies);
      case "GET /home": {
        const user = users.get(sessions.get(cookies[SESSION_COOKIE]));
        if (!user) return redirect("/sign-in");
        return json(200, { page: `${name} home`, user: { id: user.id, email: user.email } });
      }
      case "POST /logout":
        sessions.delete(cookies[SESSION_COOKIE]);
        return json(200, { ok: true }, { [SESSION_COOKIE]: null });
      case "GET /sign-in":
        return json(200, { page: `${name} sign-in`, error: url.searchParams.get("error") });
      default:
        return json(404, { error: "not found" });
    }
  }

  web.host(origin, handle);
  return { name, origin, callbackUri, users };
}
