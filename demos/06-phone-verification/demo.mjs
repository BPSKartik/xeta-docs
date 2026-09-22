// Walkthrough of phone verification by one-time code, and the ways it refuses.
// Run from the repo root:  node demos/06-phone-verification/demo.mjs
//
// Everything is in memory: a fake key, a clock the demo moves by hand, and an
// outbox that stands in for WhatsApp (reading it is "looking at the phone").
// Every claim printed is also checked with node:assert, so a wrong claim exits
// non-zero.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createVerifier,
  normalisePhone,
  CODE_TTL_MS,
  SEND_WINDOW_MS,
  MAX_SENDS,
  MAX_ATTEMPTS,
} from "./verifier.mjs";

const KEY = "demo-pepper-not-real"; // obviously fake; the demo needs a key, not a secret

let now = Date.UTC(2026, 0, 1, 9, 0, 0);
const clock = () => now;
const wait = (ms) => (now += ms);

const outbox = [];
const deliver = (phone, code) => outbox.push({ phone, code });
const lastCode = (raw) => outbox.findLast((m) => m.phone === normalisePhone(raw))?.code;
const messagesTo = (raw) => outbox.filter((m) => m.phone === normalisePhone(raw)).length;

const v = createVerifier({ key: KEY, clock, deliver });

// Fictional numbers. Real Indian mobile numbers don't start with 0.
const ALICE = "+91 00000 00001";
const BOB = "+91 00000 00002";
const STRANGER = "+91 00000 00003";

// A code guaranteed to differ from `code`: shift it by n, wrapping at a million.
const wrong = (code, n = 1) => String((Number(code) + n) % 1_000_000).padStart(6, "0");

let step = 0;
const heading = (title) => console.log(`\n${++step}. ${title}`);
const show = (label, r) => {
  const outcome = r.ok ? "ok" : `refused ${r.status}: ${r.error}`;
  const tries = r.triesLeft === undefined ? "" : ` (${r.triesLeft} tries left)`;
  console.log(`   ${label.padEnd(46)} ${outcome}${tries}`);
};

let r;

// ---------------------------------------------------------------------------
heading("Alice asks for a code. Only its keyed hash is stored.");
r = v.send("alice", ALICE);
show("send a code to Alice's number", r);
assert.equal(r.ok, true);

const aliceCode = lastCode(ALICE);
const alicePhone = normalisePhone(ALICE);
const row = v.leakRow(alicePhone);
console.log(`   stored row: hash ${row.hash.slice(0, 16)}..., wrong tries ${row.wrongTries}, sends this hour ${row.sends}`);
assert.match(row.hash, /^[0-9a-f]{64}$/);
assert.ok(!Object.values(row).includes(aliceCode), "the code itself is not in the row");

// ---------------------------------------------------------------------------
heading("Someone leaks that row and tries every code from 000000 to 999999.");
// For contrast: what the row would hold with a plain, unkeyed hash.
const unkeyed = createHash("sha256").update(`${alicePhone}:${aliceCode}`).digest("hex");
let fromUnkeyed = null;
let fromKeyed = null;
for (let i = 0; i < 1_000_000; i++) {
  const guess = String(i).padStart(6, "0");
  const h = createHash("sha256").update(`${alicePhone}:${guess}`).digest("hex");
  if (h === unkeyed) fromUnkeyed = guess;
  if (h === row.hash) fromKeyed = guess;
}
console.log(`   unkeyed hash: code recovered (${fromUnkeyed === aliceCode ? "it is Alice's" : "?"})`);
console.log(`   keyed hash:   ${fromKeyed === null ? "no guess matches without the key" : "recovered"}`);
assert.equal(fromUnkeyed, aliceCode, "a million guesses undo an unkeyed hash");
assert.equal(fromKeyed, null, "without the key there is nothing to test guesses against");

// ---------------------------------------------------------------------------
heading("A wrong code, the right code from the wrong account, then Alice.");
r = v.verify("alice", ALICE, wrong(aliceCode));
show("Alice types a wrong code", r);
assert.equal(r.status, 400);
assert.equal(r.triesLeft, MAX_ATTEMPTS - 1);

r = v.verify("mallory", ALICE, aliceCode);
show("Mallory types Alice's code from her account", r);
assert.equal(r.status, 400);
assert.equal(v.leakRow(alicePhone).wrongTries, 1, "Mallory's try spent none of Alice's");

r = v.verify("alice", ALICE, aliceCode);
show("Alice types the right code", r);
assert.equal(r.ok, true);
assert.equal(v.account("alice").verified, true);

// ---------------------------------------------------------------------------
heading("A code works once.");
r = v.verify("alice", ALICE, aliceCode);
show("Alice submits the same code again", r);
assert.equal(r.status, 400);
assert.equal(v.leakRow(alicePhone), undefined, "the row was deleted on success");

// ---------------------------------------------------------------------------
heading("After five wrong tries, even the right code is refused.");
assert.equal(MAX_ATTEMPTS, 5);
v.send("bob", BOB);
const bobFirst = lastCode(BOB);
for (let n = 1; n <= MAX_ATTEMPTS; n++) {
  r = v.verify("bob", BOB, wrong(bobFirst, n));
  assert.equal(r.status, 400);
}
show(`Bob guesses wrong ${MAX_ATTEMPTS} times`, r);
assert.equal(r.triesLeft, 0);

r = v.verify("bob", BOB, bobFirst);
show("then types the right code", r);
assert.equal(r.status, 429, "a burned code stays burned");

// ---------------------------------------------------------------------------
heading("A new code replaces the old one, and codes expire.");
v.send("bob", BOB);
const bobSecond = lastCode(BOB);
// One time in a million the two codes coincide, and then there is no "old"
// code to try.
if (bobFirst !== bobSecond) {
  r = v.verify("bob", BOB, bobFirst);
  show("Bob types his first code", r);
  assert.equal(r.status, 400);
}

wait(CODE_TTL_MS + 60_000);
r = v.verify("bob", BOB, bobSecond);
show("Bob types his second code 11 minutes late", r);
assert.equal(r.status, 400);
assert.match(r.error, /expired/);

v.send("bob", BOB);
r = v.verify("bob", BOB, lastCode(BOB));
show("a third code, typed straight away", r);
assert.equal(r.ok, true);

// ---------------------------------------------------------------------------
heading("Sends are limited per number, not per account.");
for (let i = 0; i < MAX_SENDS; i++) assert.equal(v.send("mallory", STRANGER).ok, true);
console.log(`   ${`Mallory sends ${MAX_SENDS} codes to a stranger`.padEnd(46)} ok`);

r = v.send("mallory", STRANGER);
show("a fourth, same account", r);
assert.equal(r.status, 429);

r = v.send("mallory-second-account", STRANGER);
show("a fourth, from a brand-new account", r);
assert.equal(r.status, 429, "a new account doesn't bring a new allowance");
assert.equal(messagesTo(STRANGER), MAX_SENDS, "the stranger's phone buzzed three times, no more");

wait(SEND_WINDOW_MS);
r = v.send("mallory-second-account", STRANGER);
show("an hour later", r);
assert.equal(r.ok, true, "the allowance comes back when the window ends");

// ---------------------------------------------------------------------------
heading("A number verified on another account is not handed over.");
const toAliceBefore = messagesTo(ALICE);
r = v.send("mallory", ALICE);
show("Mallory asks for a code to Alice's number", r);
assert.equal(r.status, 409);
assert.equal(messagesTo(ALICE), toAliceBefore, "no message reached Alice's phone");

// ---------------------------------------------------------------------------
heading("Editing the number drops the tick.");
v.editPhone("alice", "+91 00000 00004");
console.log(`   ${"Alice types a different number".padEnd(46)} verified: ${v.account("alice").verified}`);
assert.equal(v.account("alice").verified, false);

console.log("\nAll checks passed.");
