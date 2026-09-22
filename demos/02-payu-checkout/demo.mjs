// Taking payments with PayU hosted checkout: a runnable walkthrough.
//
//   node demos/02-payu-checkout/demo.mjs
//
// Zero dependencies, no network. PayU is simulated in-process by fake-payu.mjs,
// which holds the same fake key and salt as the store, just as the real
// gateway holds the merchant's. Every claim printed below is also asserted.
import assert from "node:assert/strict";
import {
  payuEndpoint, requestHash, requestHashString, responseHash, responseHashString,
  verifyResponseHash, redact,
} from "./payu.mjs";
import { createFakePayU } from "./fake-payu.mjs";
import { createStore } from "./store.mjs";

// Obviously fake. The key is not a secret: it goes to the browser inside the
// form. The salt is the secret, and it never leaves the server.
const creds = { key: "demo-key-not-real", salt: "demo-salt-not-real" };
const settings = {}; // DEMO_TEST_MODE unset -> test endpoint
// The buyer's email is one of the signed fields, so it needs a value. This is
// a placeholder, not an address; nothing in the demo validates it.
const BUYER_EMAIL = "demo-buyer-email";

const say = (s = "") => console.log(s);
const step = (n, title) => say(`\n${n}. ${title}`);
const ok = (s) => say(`   ok   ${s}`);
const note = (s) => say(`        ${s}`);

// What the checkout page does with the server's reply: build a hidden form
// from `params` and submit it to `action`. Here the "form" is a plain object
// the buyer can edit before it goes, which is exactly the threat.
const toPayU = (payu, reply, edit = (f) => f, opts) => payu.submit(edit({ ...reply.params }), opts);

say("PayU hosted checkout demo (fake key and salt, no network)");

// ---------------------------------------------------------------------------
step(1, "Test unless told otherwise");
for (const [label, s, expected] of [
  ["unset", {}, "https://test.payu.in/_payment"],
  ['"0"', { DEMO_TEST_MODE: "0" }, "https://test.payu.in/_payment"],
  ['"False"', { DEMO_TEST_MODE: "False" }, "https://test.payu.in/_payment"],
  ['"false"', { DEMO_TEST_MODE: "false" }, "https://secure.payu.in/_payment"],
]) {
  assert.equal(payuEndpoint(s).paymentUrl, expected);
  note(`DEMO_TEST_MODE=${label.padEnd(8)} -> ${expected}`);
}
ok('only the exact string "false" reaches the live endpoint');

// ---------------------------------------------------------------------------
step(2, "The server prices the cart; the client's prices are never read");
const store = createStore({ creds, settings });
const payu = createFakePayU(creds);

// A doctored request: prices, a total, and a product that doesn't exist.
const forged = {
  method: "online",
  total: 1,
  items: [
    { slug: "desk-lamp", qty: 1, price: 1 },
    { slug: "steel-bottle", qty: "2", price: 0 },
    { slug: "free-television", qty: 1, price: 0 },
  ],
  billing: { name: "Demo Buyer", email: BUYER_EMAIL },
};
const replyA = store.placeOrder(forged);
assert.equal(replyA.status, 200);
const a = replyA.body;
const orderA = store.order(a.orderId);
// 899 + 2 x 349 = 1597, over the free-delivery line, so no delivery fee.
assert.equal(orderA.total, 1597);
assert.equal(a.params.amount, "1597.00");
assert.deepEqual(orderA.lines.map((l) => l.slug), ["desk-lamp", "steel-bottle"]);
note(`client claimed total 1 with prices 1 and 0; server computed ${a.params.amount}`);
ok("unknown product dropped, prices taken from the catalogue");

// ---------------------------------------------------------------------------
step(3, "Signing the PayU form (forward hash)");
const fwd = requestHashString(creds, a.params);
note(redact(fwd, creds));
// Pin the layout to PayU's documented sequence, blanks and all.
assert.equal(redact(fwd, creds),
  `<key>|${a.orderId}|1597.00|Demo store order|Demo Buyer|${BUYER_EMAIL}|${a.orderId}||||store-order||||||<salt>`);
note(`hash = sha512(...) = ${a.params.hash.slice(0, 24)}...`);
assert.equal(a.params.hash, requestHash(creds, a.params));
assert.equal(a.action, "https://test.payu.in/_payment");
assert.equal(orderA.status, "awaiting_payment");
assert.equal(store.buyerOrders().length, 0);
ok("order saved as awaiting_payment and kept off the store's order page");

// ---------------------------------------------------------------------------
step(4, "Attack: the buyer edits the amount before it reaches PayU");
const cheap = toPayU(payu, a, (f) => ({ ...f, amount: "1.00" }));
assert.equal(cheap.accepted, false);
note(`amount 1597.00 -> 1.00: PayU says "${cheap.error}"`);
// Even a harmless-looking reformat breaks it: the hash covers the exact string.
const tidied = toPayU(payu, a, (f) => ({ ...f, amount: "1597" }));
assert.equal(tidied.accepted, false);
note(`amount 1597.00 -> 1597: PayU says "${tidied.error}"`);
assert.equal(orderA.status, "awaiting_payment");
assert.equal(store.stockOf("desk-lamp"), 1);
ok("refused before any money moved; order and stock untouched");

// ---------------------------------------------------------------------------
step(5, "Honest payment, verified on the way back (reverse hash)");
// PayU adds a convenience charge on top; the reverse string then gets it as a prefix.
const paidA = toPayU(payu, a, undefined, { outcome: "success", additionalCharges: "15.00" });
assert.equal(paidA.accepted, true);
const echoed = Object.fromEntries(new URLSearchParams(paidA.callback.body));
const rev = redact(responseHashString(creds, echoed), creds);
note(rev);
assert.equal(rev,
  `15.00|<salt>|success||||||store-order||||${a.orderId}|${BUYER_EMAIL}|Demo Buyer|Demo store order|1597.00|${a.orderId}|<key>`);
assert.equal(verifyResponseHash(creds, echoed), true);
assert.equal(verifyResponseHash(creds, { ...echoed, hash: echoed.hash.toUpperCase() }), true);
assert.equal(verifyResponseHash(creds, { ...echoed, additionalCharges: "" }), false);

// Attack on the response: same body, amount lowered in transit.
const lowered = new URLSearchParams({ ...echoed, amount: "1.00" }).toString();
const r1 = store.handleCallback(lowered);
assert.match(r1.location, /status=unverified/);
assert.equal(orderA.status, "awaiting_payment");
note("response with amount edited to 1.00 -> status=unverified, nothing written");

const r2 = store.handleCallback(paidA.callback.body);
assert.equal(r2.status, 303);
assert.match(r2.location, /status=paid/);
assert.equal(orderA.status, "confirmed");
assert.ok(orderA.paidTime instanceof Date);
assert.equal(orderA.paymentRef, echoed.mihpayid);
assert.equal(store.stockOf("desk-lamp"), 0); // the shelf moves only now
assert.equal(store.outbox.filter((m) => m.orderId === a.orderId && m.paid).length, 1);
assert.deepEqual(store.buyerOrders().map((o) => o.orderId), [a.orderId]);
note(`genuine response -> 303 ${new URL(r2.location).pathname}?...status=paid`);
ok("confirmed, paid time and payment id stored, stock taken, receipt queued");

// ---------------------------------------------------------------------------
step(6, "Attack: forged success callbacks for an unpaid order");
const replyC = store.placeOrder({
  method: "online", items: [{ slug: "notebook", qty: 2 }],
  billing: { name: "Demo Buyer", email: BUYER_EMAIL },
});
const c = replyC.body;
assert.equal(store.order(c.orderId).total, 280); // 2 x 120 + 40 delivery
const declined = toPayU(payu, c, undefined, { outcome: "failure" });
store.handleCallback(declined.callback.body);
assert.equal(store.order(c.orderId).status, "cancelled");
note("card declined -> signed failure -> placeholder retired to cancelled");

const failBody = Object.fromEntries(new URLSearchParams(declined.callback.body));
const forgeries = {
  // Flip failure to success. `status` is inside the reverse hash.
  "failure flipped to success": { ...failBody, status: "success" },
  // Field order is public; the salt is not. A guessed salt gets nowhere.
  "hash built with a guessed salt": (() => {
    const f = { ...failBody, status: "success" };
    return { ...f, hash: responseHash({ key: creds.key, salt: "guess" }, f) };
  })(),
  // A real, paid response for order A, re-pointed at order C.
  "order A's paid response moved to C": { ...echoed, txnid: c.orderId, udf1: c.orderId },
};
for (const [label, body] of Object.entries(forgeries)) {
  const r = store.handleCallback(new URLSearchParams(body).toString());
  assert.match(r.location, /status=unverified/, label);
  note(`${label.padEnd(36)} -> unverified`);
}
assert.equal(store.order(c.orderId).status, "cancelled");
assert.equal(store.order(c.orderId).paidTime, null);
assert.ok(!store.buyerOrders().some((o) => o.orderId === c.orderId));
ok("all rejected; order C never counted as paid");

// ---------------------------------------------------------------------------
step(7, "A later failure cannot undo a payment");
// A genuine, signed failure for order A that arrives after it was paid: a stale
// second tab, or an old failure response replayed. The fake gateway will sign
// a second attempt for the same txnid; the point is what the callback does.
const retry = toPayU(payu, a, undefined, { outcome: "failure" });
const r3 = store.handleCallback(retry.callback.body);
assert.match(r3.location, /status=failed/);
assert.equal(orderA.status, "confirmed");
ok("verified failure for a paid order: order A stays confirmed");

// ---------------------------------------------------------------------------
step(8, "Stock: check before the money, take after it");
const shop2 = createStore({ creds, settings });
const payu2 = createFakePayU(creds);
const lamp = (who) => shop2.placeOrder({
  method: "online", items: [{ slug: "desk-lamp", qty: 1 }],
  billing: { name: who, email: BUYER_EMAIL },
}).body;
// Two buyers reach checkout for the last lamp. Neither holds it yet.
const x = lamp("Buyer X");
const y = lamp("Buyer Y");
assert.equal(shop2.stockOf("desk-lamp"), 1);
shop2.handleCallback(toPayU(payu2, x).callback.body);
shop2.handleCallback(toPayU(payu2, y).callback.body);
assert.equal(shop2.order(x.orderId).status, "confirmed");
assert.equal(shop2.order(y.orderId).status, "confirmed");
assert.equal(shop2.order(y.orderId).oversold, "1 x Desk lamp");
note("both paid; the second is confirmed and flagged oversold for a human");
const late = shop2.placeOrder({ method: "online", items: [{ slug: "desk-lamp", qty: 1 }], billing: {} });
assert.equal(late.status, 409);
note(`a third buyer is told before paying: "${late.body.error}"`);
ok("an abandoned checkout never holds stock; a paid one is never refused");

// ---------------------------------------------------------------------------
step(9, "No credentials, no online payment");
const unset = createStore({ creds: { key: creds.key, salt: "" }, settings });
const refused = unset.placeOrder({ method: "online", items: [{ slug: "notebook", qty: 1 }], billing: {} });
assert.equal(refused.status, 400);
assert.equal(refused.body.params, undefined);
const cod = unset.placeOrder({ method: "cod", items: [{ slug: "notebook", qty: 1 }], billing: {} });
assert.equal(cod.status, 200);
assert.equal(unset.buyerOrders().length, 1);
ok("with the salt missing, nothing is signed; cash on delivery still works");

say("\nAll checks passed.");
