// Xeta Account, simplified: one identity provider, two apps, one sign-in.
// Run from the repo root:  node demos/01-xeta-account-sso/demo.mjs
//
// Everything is in memory: no ports, no network, no database. Every claim the
// walkthrough prints is checked with node:assert first, so a wrong claim
// stops the run with a non-zero exit.

import assert from "node:assert/strict";
import { createWeb, Browser } from "./web.mjs";
import { createIdp, safeNext, sha256, CODE_TTL_MS, SESSION_COOKIE } from "./idp.mjs";
import { createConsumerApp } from "./consumer.mjs";

// A clock we control, so "five minutes later" takes no time.
let clock = Date.parse("2026-01-01T09:00:00Z");
const now = () => clock;

const IDP = "https://xeta.test";
const KEVO = "https://kevo.test";
const VIBZY = "https://vibzy.test";
const KEVO_CB = `${KEVO}/callback`;

// Fake secrets. Real ones live only in server configuration, one per app,
// known to that app and the IdP and nowhere else.
const SECRETS = { kevo: "demo-kevo-secret-not-real", vibzy: "demo-vibzy-secret-not-real" };

const web = createWeb();
const idp = createIdp({
  origin: IDP,
  now,
  clients: [
    // Exact URLs, not prefixes. The www host is a separate entry because
    // nothing is normalised.
    { id: "kevo", redirectUris: [KEVO_CB, "https://www.kevo.test/callback"], secret: SECRETS.kevo },
    { id: "vibzy", redirectUris: [`${VIBZY}/callback`], secret: SECRETS.vibzy },
    { id: "unconfigured", redirectUris: ["https://new-app.test/callback"], secret: null },
  ],
});
web.host(IDP, idp.handle);

// Kevo reads the IdP's user table (shared database); Vibzy keeps its own.
const kevo = createConsumerApp({ web, name: "Kevo", origin: KEVO, clientId: "kevo", secret: SECRETS.kevo, idpOrigin: IDP, sharedUsers: idp.tables.users });
const vibzy = createConsumerApp({ web, name: "Vibzy", origin: VIBZY, clientId: "vibzy", secret: SECRETS.vibzy, idpOrigin: IDP });

// ── printing helpers ─────────────────────────────────────────────────────────

const say = (line = "") => console.log(line);
const section = (title) => say(`\n${title}`);
function ok(condition, claim) {
  assert.ok(condition, claim);
  say(`   ok       ${claim}`);
}
function refused(res, status, what) {
  assert.equal(res.status, status, what);
  say(`   refused  ${what}  [${status} ${res.data?.error ?? ""}]`);
}
// Show each request since `mark`: who sent it, and the URL with the values of
// query parameters left out (codes and state are long and random).
function showRequests(mark) {
  for (const { via, method, href } of web.log.slice(mark)) {
    const u = new URL(href);
    const keys = [...u.searchParams.keys()];
    say(`     ${via.padEnd(7)} ${method.padEnd(4)} ${u.host}${u.pathname}${keys.length ? `?${keys.join("&")}` : ""}`);
  }
}
async function walk(browser, href, opts) {
  const mark = web.log.length;
  const res = await browser.go(href, opts);
  showRequests(mark);
  return res;
}

// ── scenario helpers ─────────────────────────────────────────────────────────

function authorizeUrl({ idpOrigin = IDP, clientId = "kevo", redirectUri = KEVO_CB, state = "demo-state" } = {}) {
  const u = new URL("/authorize", idpOrigin);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.href;
}

// Send a signed-in browser to authorize, but stop before the redirect back and
// read the code off the Location header. That is what anyone who can see the
// URL (history, a log, a proxy) gets.
async function catchCode(browser, opts) {
  const res = await browser.go(authorizeUrl(opts), { follow: false });
  assert.equal(res.status, 302);
  return new URL(res.location).searchParams.get("code");
}

const exchange = (code, { idpOrigin = IDP, clientId = "kevo", secret = SECRETS.kevo, redirectUri = KEVO_CB } = {}) =>
  web.backChannel(`${idpOrigin}/token`, { client_id: clientId, client_secret: secret, code, redirect_uri: redirectUri });

const DEMO = { name: "Demo User", email: "demo@example.test", password: "demo-password-1" };

// ─────────────────────────────────────────────────────────────────────────────

say("Xeta Account demo: an OAuth-lite identity provider and two apps, in memory");

section("1. Sign in once, use both apps");
const you = new Browser(web);
let res = await walk(you, `${KEVO}/start`);
ok(res.data.page === "sign-in", "no IdP session yet, so authorize sent you to the sign-in page");
ok(safeNext(res.data.next)?.startsWith("/authorize"), "the sign-in page knows to return to authorize afterwards");

say("     (you sign up on that page)");
res = await walk(you, `${IDP}/signup`, { method: "POST", body: { ...DEMO, next: res.data.next } });
const xetaUser = [...idp.tables.users.values()][0];
ok(res.data.page === "Kevo home" && res.data.user.id === xetaUser.id, "Kevo signed you in as the IdP's own user row (shared database)");
const kevoCallback = web.log.findLast((e) => e.href.startsWith(KEVO_CB));

say("     (now Continue with Xeta on Vibzy)");
const mark = web.log.length;
res = await walk(you, `${VIBZY}/start`);
ok(!web.log.slice(mark).some((e) => e.href.startsWith(`${IDP}/sign-in`)), "no sign-in page this time: the IdP session was already there");
ok(res.data.page === "Vibzy home" && res.data.user.email === DEMO.email, "Vibzy signed you in, linked by email");
const vibzyId = res.data.user.id;
ok(vibzyId !== xetaUser.id, "to a Vibzy row with Vibzy's own id (separate database)");

await you.go(`${VIBZY}/logout`, { method: "POST" });
res = await you.go(`${VIBZY}/start`);
ok(res.data.user.id === vibzyId && vibzy.users.size === 1, "signing in to Vibzy again finds the same account, no duplicate");

section("2. The IdP's session cookie");
const rawCookie = you.jar(IDP).get(SESSION_COOKIE);
ok(!idp.tables.sessions.has(rawCookie) && idp.tables.sessions.has(sha256(rawCookie)), "the IdP stores sha256(cookie), never the cookie itself");

section("3. A code works once, and only for five minutes");
const usedCode = new URL(kevoCallback.href).searchParams.get("code");
ok(!idp.tables.codes.has(usedCode) && idp.tables.codes.has(sha256(usedCode)), "codes are stored hashed as well");
refused(await exchange(usedCode), 400, "replaying the code Kevo already used, with Kevo's real secret");

let code = await catchCode(you);
clock += CODE_TTL_MS + 1000;
refused(await exchange(code), 400, "a fresh code redeemed 5 min 1 s after it was issued");

code = await catchCode(you);
const race = await Promise.all([exchange(code), exchange(code)]);
ok(race.filter((r) => r.status === 200).length === 1, "two redemptions of one code at the same moment: exactly one wins");

// The same race against an IdP that checks "unused" in its read and then
// writes unconditionally.
const NAIVE = "https://naive-idp.test";
const naive = createIdp({ origin: NAIVE, now, claim: "check-then-set", clients: [{ id: "kevo", redirectUris: [KEVO_CB], secret: SECRETS.kevo }] });
web.host(NAIVE, naive.handle);
const other = new Browser(web);
await other.go(`${NAIVE}/signup`, { method: "POST", body: DEMO });
code = await catchCode(other, { idpOrigin: NAIVE });
const naiveRace = await Promise.all([exchange(code, { idpOrigin: NAIVE }), exchange(code, { idpOrigin: NAIVE })]);
ok(naiveRace.every((r) => r.status === 200), "for contrast, a check-then-set IdP lets BOTH win, so the claim must be a conditional write");

section("4. Redirect URIs: exact match or nothing");
const codesBefore = idp.tables.codes.size;
res = await you.go(authorizeUrl({ redirectUri: "https://attacker.test/steal" }));
refused(res, 400, "a link to authorize with redirect_uri on an attacker's site");
ok(!res.location && idp.tables.codes.size === codesBefore, "no redirect and no code minted: the error stays on the IdP");
for (const nearMiss of [
  `${KEVO_CB}/`,
  `${KEVO_CB}?then=https://attacker.test`,
  "http://kevo.test/callback",
  "https://kevo.test.attacker.test/callback",
]) {
  refused(await you.go(authorizeUrl({ redirectUri: nearMiss })), 400, `near miss ${nearMiss}`);
}
refused(await you.go(authorizeUrl({ clientId: "nobody" })), 400, "an unknown client_id");

section("5. The token exchange: secret, client and redirect URI must all match");
say("     (someone has caught a Kevo code in flight; client_id and redirect_uri are public anyway)");
code = await catchCode(you);
refused(await exchange(code, { secret: "demo-kevo-secret-not-reax" }), 401, "right length, wrong secret");
refused(await exchange(code, { secret: "guess" }), 401, "wrong length (checked first, so timingSafeEqual never throws)");
refused(await exchange(code, { clientId: "vibzy", secret: SECRETS.vibzy }), 400, "Vibzy's real credentials with Kevo's code");
refused(await exchange(code, { redirectUri: "https://www.kevo.test/callback" }), 400, "another allowed URI, not the one the code was issued for");
refused(await exchange(code, { clientId: "unconfigured", secret: "" }), 503, "a client with no secret configured");
res = await exchange(code);
ok(res.status === 200 && res.data.user.email === DEMO.email, "the real Kevo, with everything matching, gets the profile");
ok(Object.keys(res.data.user).join() === "id,name,email", "the answer is a profile only: no access token, no password hash");

section("6. state: a planted callback link is refused");
const mallory = new Browser(web);
await mallory.go(`${IDP}/signup`, { method: "POST", body: { name: "Mallory", email: "mallory@example.test", password: "mallory-password" } });
res = await mallory.go(`${KEVO}/start`, { follow: false }); // Kevo gives Mallory a state cookie
res = await mallory.go(res.location, { follow: false }); // the IdP answers with a code for Mallory
const planted = res.location; // Mallory stops here and sends you this link
res = await you.go(planted);
ok(res.data.page === "Kevo sign-in" && res.data.error === "state mismatch", "you open Mallory's callback link: Kevo refuses it, the state isn't yours");
res = await you.go(`${KEVO}/home`);
ok(res.data.user.email === DEMO.email, "and on Kevo you are still you, not Mallory");

section("7. After sign-in, same-origin paths only");
ok(safeNext("/authorize?client_id=kevo") !== null, "'/authorize?...' is accepted");
for (const bad of ["//attacker.test/x", "/\\attacker.test", "https://attacker.test/"]) {
  ok(safeNext(bad) === null, `'${bad}' is refused`);
}
const fresh = new Browser(web);
res = await fresh.go(`${IDP}/login`, { method: "POST", body: { email: DEMO.email, password: DEMO.password, next: "//attacker.test/x" } });
ok(res.url === `${IDP}/hub`, "signing in with next=//attacker.test/x lands on the IdP's own account page");
const wrongPassword = await fresh.go(`${IDP}/login`, { method: "POST", body: { email: DEMO.email, password: "not-the-password" } });
const noSuchUser = await fresh.go(`${IDP}/login`, { method: "POST", body: { email: "nobody@example.test", password: "whatever-123" } });
refused(wrongPassword, 401, "a wrong password");
ok(wrongPassword.data.error === noSuchUser.data.error, "an unknown email gets the very same answer");

section("8. Signing out of the IdP");
ok((await you.go(`${IDP}/me`)).data.user?.email === DEMO.email, "/me knows you");
await you.go(`${IDP}/logout`, { method: "POST" });
ok(!idp.tables.sessions.has(sha256(rawCookie)), "logout deleted the session row, not just the cookie");
ok((await you.go(`${IDP}/me`)).data.user === null, "/me: signed out");
res = await you.go(`${KEVO}/home`);
ok(res.data.page === "Kevo home", "Kevo keeps its own session: signing out of the IdP is not a global sign-out");
res = await you.go(`${VIBZY}/start`);
ok(res.data.page === "sign-in", "but the next Continue with Xeta asks you to sign in again");

say("\nAll checks passed.");
