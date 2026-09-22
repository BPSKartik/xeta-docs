# Links that stand in for a login (HMAC order tokens)

Shipped in July 2026. A review link that needs no sign-in came first; a receipt link followed the same day, and the signing moved into one helper that takes a purpose.

## What problem it solves

The store's order emails and WhatsApp messages can carry two links that open something belonging to one order: the receipt PDF, and a page for reviewing what was bought. A sign-in screen in front of either would defeat it. Few people look up a store password to say a cable was fine, and a buyer forwarding a receipt to an accountant should not have to hand over a password with it.

So the link carries its own proof. It is not a session. It proves one narrow thing, that the holder got the link from a message we sent about this order, and that is the right amount of access for a receipt or a review.

## How it works

The token is an HMAC-SHA256 of the string `<purpose>:<orderId>`, keyed with a secret that stays on the server, encoded as base64url and cut to its first 24 characters. The order id and the token both sit in the link's path.

```
 send:  token = HMAC(key, "invoice:" + id), first 24 chars
        link  = <store>/.../<id>/<token>

 open:  expected = token for (route's purpose, id from path)
        same byte length?  --no-->  404
        timingSafeEqual?   --no-->  404
        order exists?      --no-->  404
        serve the receipt
```

1. When an order message is built, a helper computes the token for `("invoice", orderId)` and puts the id and the token into the URL.
2. When the URL is opened, the receipt route recomputes the token for its own purpose and the id in the path.
3. On a mismatch it answers 404 without reading the database.
4. Only then does it load the order; if there is none, the answer is the same 404.

The review page makes the same check, with the purpose `review`, before it reads anything. The shared helper knows exactly two purposes, `review` and `invoice` (the receipt).

## Decisions that matter

**Derive, don't store.** Any token can be recomputed from the key, the purpose and the order id, so nothing about a link is saved: no token column, no migration, no clean-up job. And because the order is loaded after the check, a token cannot outlive the order it belongs to.

**The purpose is inside the signature.** The receipt link is meant to be forwarded. If the token signed only the order id, a forwarded receipt token would also pass the review page's check. Signing `purpose:orderId` means one leaked link buys exactly one thing. Each route hard-codes the purpose it checks; the purpose is never read from the request.

**Check before reading.** The check needs only the key, so a forged link costs no database query, and nobody without a real link gets far enough to learn whether an order id exists.

**All the secrecy is in the key.** The order id travels in plain text and the scheme has to hold even if ids can be guessed, so the key must be a real secret: one written into source code would let anyone who could read the code mint a working link for any order.

**Length first, then a timing-safe compare.** A plain `===` may stop at the first wrong character, so timing can reveal how much of a guess was right. `crypto.timingSafeEqual` does not, but it throws when its buffers differ in length, and an exception in a route is a server error, not a clean "no". So the byte lengths are compared first, which gives nothing away because every real token has the same length. Empty input is refused up front and the token is coerced to a string, so malformed input comes back as `false`.

**Short tokens.** Twenty-four base64url characters keep 144 of the MAC's 256 bits. That keeps the link short and is still far beyond guessing one request at a time.

**The payload is a wire format.** The first version already signed `review:<orderId>`. When the helper was generalised to take a purpose, that payload, the encoding and the cut stayed exactly as they were, so review links built by the first version still verify under the same key. Changing any of the three would quietly turn every link already sent into a 404.

## The trade-offs

- **No revoking one link.** With no row to delete, a single leaked link cannot be switched off without the stored state this design avoids.
- **No expiry.** Nothing time-based is signed. For a receipt that is intended, since it may be needed months later, but a leaked link also stays valid.
- **Rotating the key invalidates every link already sent**, for every order and both purposes. Short of the order itself going away, the key is the only lever, and it is all or nothing.
- **It is a bearer credential.** Forwarding the message forwards the access.

## The demo

```
node demos/03-signed-links/demo.mjs
```

Node 20 or later, no dependencies. `signer.mjs` mints and verifies tokens; `store.mjs` is a small `node:http` server on 127.0.0.1 with review and receipt routes over two made-up orders, counting order reads. The script:

1. builds a review link and a receipt link for one order; the tokens are deterministic and differ by purpose;
2. verifies each for its own purpose;
3. attacks: cross-purpose and cross-order tokens, truncated, lengthened, altered and multi-byte tokens, a guessed key, an unkeyed hash, and empty or non-string input, each refused without throwing (bare `timingSafeEqual` would throw on the truncated one);
4. repeats this over HTTP: good links get 200, bad ones the same 404 with no order read, and a valid token for a missing order that same 404;
5. rotates the key: every old link stops working, new ones work, and a review-only helper signing the same payload still agrees with the shared one.

Every claim is checked with `node:assert`; the script exits 0 only if all of them hold.

## Limits of the demo

It is simplified: no framework, database, email, WhatsApp, PDF or review form. The purpose set is checked at runtime; in a typed codebase a union type can enforce it at compile time. The key is a fake constant, and the host and paths are placeholders. The demo models the token check only, not any other rules a real receipt or review page would have, and it does not cover how a server should store and load its key.
