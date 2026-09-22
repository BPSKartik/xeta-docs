// Links that stand in for a login: HMAC order tokens, walked through.
//
// Run from the repo root:  node demos/03-signed-links/demo.mjs
// Node 20+, no dependencies. Every claim printed below is checked with
// node:assert, so the script exits non-zero if any of them stops holding.

import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createSigner, linkFor, TOKEN_LENGTH } from "./signer.mjs";
import { startStore } from "./store.mjs";

// Obviously fake. A real key is held by the server and never written in source:
// anyone who could read it could mint a working link for any order id.
const KEY = "demo-key-not-real-0001";

const signer = createSigner(KEY);
const orders = new Map([
  ["DEMO-1001", { items: ["USB-C cable"], total: "INR 299" }],
  ["DEMO-1002", { items: ["Desk lamp"], total: "INR 1149" }],
]);

const step = (n, title) => console.log(`\n${n}. ${title}`);
const ok = (msg) => console.log(`   ok       ${msg}`);
const note = (msg) => console.log(`   note     ${msg}`);

// Every attack must come back as a plain false: no exception, no "maybe".
function mustRefuse(label, purpose, orderId, token, s = signer) {
  let result;
  assert.doesNotThrow(() => {
    result = s.verify(purpose, orderId, token);
  }, label);
  assert.equal(result, false, label);
  console.log(`   refused  ${label}`);
}

// --- 1 -----------------------------------------------------------------------
step(1, "Build the two links for order DEMO-1001");
const reviewLink = linkFor(signer, "review", "DEMO-1001");
const receiptLink = linkFor(signer, "invoice", "DEMO-1001");
console.log(`   review   ${reviewLink}`);
console.log(`   receipt  ${receiptLink}`);

const reviewTok = signer.mint("review", "DEMO-1001");
const receiptTok = signer.mint("invoice", "DEMO-1001");
assert.match(reviewTok, new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`));
assert.match(receiptTok, new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`));
ok(`tokens are ${TOKEN_LENGTH} URL-safe characters`);
assert.notEqual(reviewTok, receiptTok);
ok("same order, different purpose: different token");
// Derive, don't store: a brand-new signer (think: another server, or the same
// one after a restart) rebuilds the identical token from the key alone.
assert.equal(createSigner(KEY).mint("review", "DEMO-1001"), reviewTok);
ok("a fresh signer with the same key rebuilds the same token; nothing was saved");

// --- 2 -----------------------------------------------------------------------
step(2, "Each link verifies for its own purpose");
assert.equal(signer.verify("review", "DEMO-1001", reviewTok), true);
ok("review token opens the review page");
assert.equal(signer.verify("invoice", "DEMO-1001", receiptTok), true);
ok("receipt token opens the receipt");

// --- 3 -----------------------------------------------------------------------
step(3, "Attacks and malformed input");
// The receipt link is the one that gets forwarded. It must not double as a
// "verified buyer" review link.
mustRefuse("receipt token presented as a review token", "review", "DEMO-1001", receiptTok);
mustRefuse("review token presented as a receipt token", "invoice", "DEMO-1001", reviewTok);
mustRefuse("DEMO-1001's review token on order DEMO-1002", "review", "DEMO-1002", reviewTok);

const truncated = reviewTok.slice(0, -1);
mustRefuse(`truncated token (${truncated.length} chars)`, "review", "DEMO-1001", truncated);
mustRefuse("token with one extra character", "review", "DEMO-1001", reviewTok + "A");
const flipped = reviewTok.slice(0, -1) + (reviewTok.at(-1) === "A" ? "B" : "A");
mustRefuse("token with its last character changed", "review", "DEMO-1001", flipped);

// Same string length, different byte length: only a byte-length check catches it.
const multiByte = reviewTok.slice(0, -1) + "é";
assert.equal(multiByte.length, TOKEN_LENGTH);
assert.equal(Buffer.byteLength(multiByte), TOKEN_LENGTH + 1);
mustRefuse("24 characters but 25 bytes (one multi-byte char)", "review", "DEMO-1001", multiByte);

// Knowing the payload format is not enough without the key.
const guessedKey = createSigner("guessed-key").mint("review", "DEMO-1001");
mustRefuse("token made with a guessed key", "review", "DEMO-1001", guessedKey);
const unkeyed = createHash("sha256").update("review:DEMO-1001").digest("base64url").slice(0, TOKEN_LENGTH);
mustRefuse("plain SHA-256 of the payload, no key", "review", "DEMO-1001", unkeyed);

mustRefuse("empty token", "review", "DEMO-1001", "");
mustRefuse("missing token", "review", "DEMO-1001", undefined);
mustRefuse("non-string token", "review", "DEMO-1001", { token: reviewTok });
mustRefuse("empty order id with a real token", "review", "", reviewTok);

// Why the length check comes first: without it, the truncated token above
// would have been an exception, i.e. a 500, instead of a clean "no".
assert.throws(
  () => timingSafeEqual(Buffer.from(reviewTok), Buffer.from(truncated)),
  { code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH" },
);
ok("timingSafeEqual on its own would have thrown on the truncated token");

// --- 4 -----------------------------------------------------------------------
step(4, "The same links over HTTP (local server on 127.0.0.1)");
const store = await startStore(signer, orders);
try {
  let r = await store.open(reviewLink);
  assert.equal(r.status, 200);
  ok(`200  review link   -> "${r.body}"`);
  r = await store.open(receiptLink);
  assert.equal(r.status, 200);
  ok(`200  receipt link  -> "${r.body}"`);

  const readsBefore = store.stats.orderReads;
  const bad = [
    ["receipt token on the review route", `/review/DEMO-1001/${receiptTok}`],
    ["truncated review token", `/review/DEMO-1001/${truncated}`],
    ["DEMO-1001's receipt token on DEMO-1002", `/receipt/DEMO-1002/${receiptTok}`],
    ["token made with a guessed key", `/review/DEMO-1001/${guessedKey}`],
    ["broken %-escape in the order id", `/receipt/%E0%A4%A/${receiptTok}`],
  ];
  const notFoundBody = (await store.openPath(bad[0][1])).body;
  for (const [label, path] of bad) {
    r = await store.openPath(path);
    assert.equal(r.status, 404, label);
    assert.equal(r.body, notFoundBody, label);
    console.log(`   refused  404  ${label}`);
  }
  // The check needs no database, so none of those requests read an order.
  assert.equal(store.stats.orderReads, readsBefore);
  ok("none of the bad links caused an order read");

  // A perfectly valid token for an order that is not there: a token cannot
  // outlive its order, and the answer is the same 404 a forged link gets.
  r = await store.open(linkFor(signer, "invoice", "DEMO-9999"));
  assert.equal(r.status, 404);
  assert.equal(r.body, notFoundBody);
  assert.equal(store.stats.orderReads, readsBefore + 1);
  ok("valid token, order does not exist: the same 404 (after one read)");
} finally {
  await store.close();
}

// --- 5 -----------------------------------------------------------------------
step(5, "The trade-off: the key is the only switch");
const rotated = createSigner("demo-key-not-real-0002");
const sent = [
  ["review", "DEMO-1001"],
  ["invoice", "DEMO-1001"],
  ["review", "DEMO-1002"],
  ["invoice", "DEMO-1002"],
];
for (const [purpose, id] of sent) {
  mustRefuse(`old ${purpose === "invoice" ? "receipt" : purpose} link for ${id}, after rotating the key`, purpose, id, signer.mint(purpose, id), rotated);
}
for (const [purpose, id] of sent) {
  assert.equal(rotated.verify(purpose, id, rotated.mint(purpose, id)), true);
}
ok("links built with the new key work");
note("there is no way to switch off one link: a token is a pure function of");
note("key, purpose and order id, so the only lever turns off every link sent.");

// The payload is a wire format. A helper that only ever made review links, and
// signed "review:" + id, must agree with the shared one, or every review link
// already in someone's inbox would quietly start returning 404.
const reviewOnly = (key, id) => createHmac("sha256", key).update(`review:${id}`).digest("base64url").slice(0, 24);
assert.equal(reviewOnly(KEY, "DEMO-1001"), reviewTok);
ok("a review-only helper with the same payload gives the same review token");

console.log("\nAll checks passed.");
