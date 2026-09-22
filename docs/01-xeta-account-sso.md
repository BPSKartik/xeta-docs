# Xeta Account: one login for Kevo and Vibzy (an OAuth-lite identity provider)

Shipped in July 2026.

## What problem it solves

Kevo and Vibzy each had their own sign-up and password. Xeta, the parent company, wanted one account for both: sign in once on the parent site (xeta.in), then press "Continue with Xeta" in either app. Both apps are first-party, with servers that can keep a secret. Full OAuth 2.0 with OpenID Connect was more than that needed, so Xeta Account keeps the authorization-code flow and drops the rest.

## How it works

```
browser             app (Kevo / Vibzy)                  Xeta (IdP)
   | Continue with Xeta   |                                   |
   |--------------------->| random state -> cookie            |
   |<-- 302 authorize?client_id&redirect_uri&state             |
   |---------------------------------------------------------->| client known? redirect_uri exact?
   |                      |                                   | signed in? (no: sign-in page, then back)
   |<-- 302 redirect_uri?code&state ---------------------------| code: random, hashed, 5 min, one use
   |--------------------->| state == cookie?                  |
   |                      |-- POST token endpoint ----------->| secret ok? (constant time)
   |                      |   client_id, client_secret,       | claim the code (conditional write)
   |                      |   code, redirect_uri              |
   |                      |<-- { id, name, email, avatar } ---|
   |<-- signed in --------| find or link user, own session    |
```

1. The app stores a random `state` in a short-lived httpOnly cookie and redirects to authorize.
2. Authorize rejects an unknown client or an unlisted `redirect_uri` with a 400.
3. With no Xeta session, the browser detours through the sign-in page and comes back.
4. Otherwise the IdP redirects to `redirect_uri` with a new code and the unchanged `state`. No consent screen: both clients are first-party.
5. The app checks `state`, then its server trades the code for the user's profile at the token endpoint.
6. The app maps the profile to a local user and starts its own session.

The IdP's own session (behind sign-up, sign-in, sign-out and "who am I") is a random 32-byte token in an httpOnly, SameSite=Lax cookie that lasts 30 days. The server stores only its SHA-256 hash, and logout deletes that row.

## Decisions that matter

**Five minutes, one use.** Only the code crosses the browser, where history and logs can see it, so it has to die fast. The real redirect uses it within seconds; five minutes only allows for a slow network. The secret and the profile travel server to server. Codes are 32 random bytes and, like session tokens, are stored only as hashes.

**One use is enforced by the write, not the read.** Read, check, then write lets two concurrent requests both see the code as unused. So the claim is an update that matches only while the code's "used" marker is still empty, and a request wins only if exactly one row changed.

**A code is bound to its client and redirect URI.** Vibzy cannot redeem Kevo's code, even with Vibzy's real secret. The token request's `redirect_uri` must equal the one the code was issued for.

**Redirect URIs match exactly.** Each client registers full callback URLs, compared as plain strings, so the bare and `www` hosts are separate entries. Prefix or pattern matching is how allowlists end up accepting an attacker's path, query or lookalike host. It runs before the session check, and a failure is a 400 on the IdP, never a redirect to the unlisted URI.

**The secret check is constant-time and fails closed.** `timingSafeEqual` takes the same time wherever the first wrong byte is. It throws on unequal lengths, so lengths are compared first, which reveals only the length. A client with no configured secret gets 503.

**SameSite=Lax, not Strict.** The browser arrives at authorize by a top-level redirect from another site. Browsers send Lax cookies on that navigation but not Strict ones.

**`state` is the app's job.** The IdP only echoes it. Without the check, an attacker could send you a callback link with a code for their own account, and you would be signed in as them.

**Sign-in returns only to same-origin paths.** `next` must start with a single `/` and contain no backslash, so the sign-in page cannot send people off-site.

**A profile, not a token.** There are no access, refresh or ID tokens. The profile comes straight from the IdP in answer to an authenticated request, so there is nothing to sign. There is no PKCE either, since both clients are servers that hold a secret. The trade-off: signing out of the IdP does not sign you out of Kevo or Vibzy.

## Shared database vs link by email

The flow is identical; what differs is what each callback does with the profile.

**Kevo shares its database with the IdP.** The IdP's user table is Kevo's user table, so the profile's id already is a Kevo user id. The callback looks the row up, never creates one, and signs the user in, so no copy exists to drift. With two codebases on one database, the IdP's new tables should arrive as additive, re-runnable migrations, so neither codebase can drop the other's tables.

**Vibzy has its own database.** A Xeta id means nothing there, so the email address is the join key. The callback finds the Vibzy user with that address. On first sign-in it creates one instead, with a generated unique handle and no local password. Then it starts an ordinary Vibzy session.

With a shared database, signing in is a lookup by id. With separate databases it is an account-linking step. Linking by email is only as trustworthy as the IdP's knowledge that the user owns that address.

## The demo

```
node demos/01-xeta-account-sso/demo.mjs
```

The demo runs on Node 20+ with no dependencies. It builds an in-memory IdP, a Kevo-like app on the IdP's user table and a Vibzy-like app that links by email, plus a small browser that follows redirects. After one sign-up it gets into both apps. It then asserts refusals: a replayed or expired code, a wrong redirect URI and near misses, wrong secrets, a code taken to another client or URI, a planted callback without matching `state`, and an off-site `next`. Two racing redemptions of one code yield exactly one winner; a check-then-set variant lets both win.

## Limits of the demo

The demo is simplified. Maps stand in for database tables, and each access yields a tick so that races are real. It hashes passwords with Node's built-in scrypt to stay dependency-free, and makes no real HTTP calls. Cookies ignore Secure and SameSite, and the sign-in page is a bare form post. The apps' sessions are plain token maps, not models of either app's code. There is no social sign-in or password reset, and the secrets are fake constants.
