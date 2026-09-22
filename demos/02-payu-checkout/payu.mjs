// PayU (India) hosted-checkout hashing, reimplemented for the demo.
//
// The merchant key and salt are passed in rather than read from server-side
// settings, so the fake gateway and the merchant can share these functions
// (PayU holds the same salt, that is the point).
import { createHash, timingSafeEqual } from "node:crypto";

export const TEST_BASE = "https://test.payu.in";
export const LIVE_BASE = "https://secure.payu.in";

// Test unless someone explicitly says otherwise. A missing setting, a typo, or
// "0" all land on the sandbox; only the exact string "false" reaches real money.
export function payuEndpoint(settings = {}) {
  const isTest = settings.DEMO_TEST_MODE !== "false";
  const base = isTest ? TEST_BASE : LIVE_BASE;
  return { isTest, paymentUrl: `${base}/_payment` };
}

// Both halves must be present. Signing with an empty salt would produce a
// hash anyone can reproduce, so "not configured" means "no online payment".
export const configured = (creds) => Boolean(creds?.key && creds?.salt);

const sha512 = (s) => createHash("sha512").update(s).digest("hex");

// The signed fields in PayU's forward order, between the key and the salt:
//   key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT
// This flow never uses udf6..udf10, but each still owns a slot. Listing them
// by name means the five blanks are visible, not a run of pipes to count.
const FIELDS = [
  "txnid", "amount", "productinfo", "firstname", "email",
  "udf1", "udf2", "udf3", "udf4", "udf5",
  "udf6", "udf7", "udf8", "udf9", "udf10",
];
const ALWAYS_BLANK = new Set(["udf6", "udf7", "udf8", "udf9", "udf10"]);
const pick = (obj, name) => (ALWAYS_BLANK.has(name) ? "" : String(obj[name] ?? ""));

export function requestHashString({ key, salt }, f) {
  return [key, ...FIELDS.map((n) => pick(f, n)), salt].join("|");
}

export const requestHash = (creds, f) => sha512(requestHashString(creds, f));

// The response runs the same list backwards, with key and salt trading ends
// and `status` placed straight after the salt:
//   SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
// If PayU added charges on top, that value goes in front: additionalCharges|SALT|...
export function responseHashString({ key, salt }, p) {
  const base = [salt, String(p.status ?? ""), ...FIELDS.toReversed().map((n) => pick(p, n)), key].join("|");
  return p.additionalCharges ? `${p.additionalCharges}|${base}` : base;
}

// Only the gateway signs responses; the merchant only ever verifies them.
export const responseHash = (creds, p) => sha512(responseHashString(creds, p));

// Recompute from the values PayU echoed back, never from what we stored:
// the question is "did PayU say exactly this?", field for field.
export function verifyResponseHash(creds, p) {
  if (!p.hash) return false;
  const a = Buffer.from(responseHash(creds, p));
  const b = Buffer.from(String(p.hash).toLowerCase());
  // timingSafeEqual throws on unequal lengths, so check that first.
  return a.length === b.length && timingSafeEqual(a, b);
}

// For printing: show the layout of a hash string without the secrets in it.
export const redact = (s, { key, salt }) => s.split(salt).join("<salt>").split(key).join("<key>");
