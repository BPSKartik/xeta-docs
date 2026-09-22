// Signed order links: a short HMAC in the URL stands in for a login.
//
// A simplified, self-contained version for these notes. The idea: the token is derived from (purpose, order id) with a key
// only the server holds, so nothing is stored and nothing needs cleaning up.

import { createHmac, timingSafeEqual } from "node:crypto";

// A closed set. Plain JS has to check it at runtime; a TypeScript union can do
// it at compile time. No purpose contains ":", so "purpose:orderId" can only be
// split one way.
export const PURPOSES = Object.freeze(["review", "invoice"]);

// 24 base64url characters keep 144 of the MAC's 256 bits: short enough for a
// chat message, far too long to guess.
export const TOKEN_LENGTH = 24;

export function createSigner(key) {
  function mint(purpose, orderId) {
    if (!PURPOSES.includes(purpose)) throw new Error(`unknown purpose: ${purpose}`);
    // The purpose goes into the signed bytes, not just the URL. That is what
    // stops a receipt token from also working as a review token.
    const mac = createHmac("sha256", key).update(`${purpose}:${orderId}`).digest("base64url");
    return mac.slice(0, TOKEN_LENGTH);
  }

  function verify(purpose, orderId, token) {
    if (!orderId || !token) return false;
    // Recompute, never look up: there is no table of issued tokens to consult.
    const want = Buffer.from(mint(purpose, orderId));
    const got = Buffer.from(String(token));
    // Byte length first. timingSafeEqual throws when lengths differ, and a throw
    // inside a route is a 500, not a "no". The length is no secret: every real
    // token has the same one. It must be the byte length, not the string
    // length, or one multi-byte character would slip past and still throw.
    if (want.length !== got.length) return false;
    // Constant-time: a plain === can stop at the first wrong character and so
    // tell an attacker, through timing, how much of a guess was right.
    return timingSafeEqual(want, got);
  }

  return { mint, verify };
}

// Where each purpose is served. The host and paths are placeholders; only the
// shape matters: <base>/<route>/<orderId>/<token>.
export const ROUTE_FOR = Object.freeze({ review: "review", invoice: "receipt" });

export function linkFor(signer, purpose, orderId, base = "https://store.example") {
  return `${base}/${ROUTE_FOR[purpose]}/${encodeURIComponent(orderId)}/${signer.mint(purpose, orderId)}`;
}
