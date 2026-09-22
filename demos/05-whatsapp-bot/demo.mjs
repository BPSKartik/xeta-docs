/**
 * A scripted WhatsApp conversation driven through the menu bot's state machine,
 * then the template gate for messages the business starts.
 *
 *   node demos/05-whatsapp-bot/demo.mjs
 *
 * No network: replies go to a fake Cloud API that enforces the 24-hour window
 * and template approval, and nothing else. Every claim printed is also asserted.
 */

import assert from "node:assert/strict";
import { createBot, HANDOVER_MS, listMessage, LIMITS } from "./bot.mjs";
import { createNotifier } from "./notify.mjs";
import { createFakeCloud } from "./fake-cloud.mjs";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

// Obviously fake numbers: ten digits of mostly zeros, which no real mobile
// number is. WhatsApp sends them with the country code in front.
const fakeLocal = (n) => "0".repeat(9) + n;
const BUYER_LOCAL = fakeLocal(1);
const BUYER = "91" + BUYER_LOCAL;
const STRANGER = "91" + fakeLocal(2);
const ADDRESS = "1 Example Road, Demo Town";

const orders = [
  {
    id: "DEMO-A1", phone: BUYER_LOCAL, name: "Demo Buyer", status: "shipped",
    courier: "Demo Courier", tracking: "TRACK-01", total: 499,
    items: [{ name: "Steel bottle", qty: 1 }], address: ADDRESS,
  },
  {
    id: "DEMO-B2", phone: BUYER_LOCAL, name: "Demo Buyer", status: "delivered",
    total: 299, items: [{ name: "Desk lamp", qty: 1 }], address: ADDRESS,
  },
  {
    // Checkout started, never paid: not an order yet, so nothing should show it.
    id: "DEMO-C3", phone: BUYER_LOCAL, name: "Demo Buyer", status: "awaiting_payment",
    total: 999, items: [{ name: "Headphones", qty: 1 }], address: ADDRESS,
  },
];

const cloud = createFakeCloud({
  // name -> how many variables its approved body takes
  approved: new Map([
    ["demo_order_shipped", 4],
    ["demo_order_delivered_v2", 3],
  ]),
});
const bot = createBot({ orders });
const templates = {
  confirmed: undefined, // not set up yet
  shipped: "demo_order_shipped", // approved
  delivered: "demo_order_delivered", // named, but never approved
};
const notifier = createNotifier({ templates, cloud, isOptedOut: bot.isOptedOut });

// ── a tiny harness ────────────────────────────────────────────────────────
let now = Date.UTC(2026, 6, 25, 9, 0);
const who = { [BUYER]: "buyer", [STRANGER]: "stranger" };

const show = (m) =>
  m.kind === "text" ? m.body.replace(/\n/g, " / ")
  : m.kind === "list" ? `[list] ${m.rows.map((r) => r.title).join(" | ")}`
  : `[buttons] ${m.buttons.map((b) => b.title).join(" | ")}`;

async function turn(phone, msg) {
  cloud.inbound(phone, now);
  const r = bot.handle(phone, msg, now);
  console.log(`  ${who[phone].padEnd(8)} > ${msg.id ? `(taps ${msg.id})` : JSON.stringify(msg.text)}`);
  if (r.silent) console.log(`  ${"bot".padEnd(8)} < (nothing: a person has this chat)`);
  for (const m of r.replies) {
    // Every reply is sent the way a real one would be, through the window check.
    const sent = await cloud.sendFree(phone, m, now);
    assert.ok(sent.ok, "a reply is always inside the window the customer opened");
    console.log(`  ${"bot".padEnd(8)} < ${show(m)}`);
  }
  return r;
}
const say = (phone, text) => turn(phone, { text });
const tap = (phone, id) => turn(phone, { id });
const step = (title) => console.log(`\n${title}`);
const wait = (ms, label) => {
  now += ms;
  console.log(`  (${label} later)`);
};
const raw = (r) => JSON.stringify(r.replies);
const business = (label, n) =>
  console.log(`  ${"business".padEnd(8)} * ${label}: ${n.sent ? `sent (${n.template})` : `not sent - ${n.reason}`}`);

// ── 1 ─────────────────────────────────────────────────────────────────────
step("1. Anything unrecognised opens a tappable menu");
let r = await say(BUYER, "hi");
assert.equal(r.replies[0].kind, "list");
assert.deepEqual(r.replies[0].rows.map((x) => x.id), ["m:track", "m:shop", "m:support"]);
r = await say(BUYER, "do you deliver on sundays??");
assert.equal(r.replies[0].kind, "list", "a stray question gets the menu, not a shrug");

// ── 2 ─────────────────────────────────────────────────────────────────────
step("2. Track my order: WhatsApp already proved the number, so no code is asked for");
r = await tap(BUYER, "m:track");
assert.deepEqual(
  r.replies[0].rows.map((x) => x.id),
  ["order:DEMO-A1", "order:DEMO-B2", "m:main"],
  "this number's placed orders, and the unpaid checkout is not among them",
);
r = await tap(BUYER, "order:DEMO-A1");
assert.match(r.replies[0].body, /On its way/);
assert.match(r.replies[0].body, /TRACK-01/);

// ── 3 ─────────────────────────────────────────────────────────────────────
step("3. State is per number; a stranger learns only what an order id tells anyone");
r = await tap(STRANGER, "m:track");
assert.equal(bot.peek(STRANGER).state, "track_wait");
assert.ok(!raw(r).includes("DEMO-"), "another number's orders are never listed");
r = await say(STRANGER, "idk");
assert.match(r.replies[0].body, /doesn't look like an order number/);

// Attack: someone else's order id, typed into a sentence and then as a forged tap.
const typed = await say(STRANGER, "where is DEMO-a1 ?");
const forged = await tap(STRANGER, "order:DEMO-B2");
for (const x of [typed, forged]) {
  assert.ok(!raw(x).includes(ADDRESS), "an order id never reveals the address");
  assert.ok(!raw(x).includes(BUYER_LOCAL), "or the phone number");
}
r = await tap(STRANGER, "order:DEMO-C3");
assert.match(r.replies[0].body, /couldn't find/, "an unpaid checkout is not an order");
assert.equal(bot.peek(BUYER).state, "menu", "the stranger's conversation never touched the buyer's");

// ── 4 ─────────────────────────────────────────────────────────────────────
step("4. Handing the chat to a person silences the bot for 24 hours");
await tap(BUYER, "m:support");
await tap(BUYER, "sup:human");
assert.equal(bot.peek(BUYER).handoverUntil, now + HANDOVER_MS);
wait(10 * MIN, "10 minutes");
r = await say(BUYER, "my parcel is late");
assert.equal(r.silent, true);
assert.equal(r.replies.length, 0, "the bot must not talk over whoever is answering");
r = await say(STRANGER, "hi");
assert.equal(r.replies[0].kind, "list", "a handover on one number leaves others alone");

// ── 5 ─────────────────────────────────────────────────────────────────────
step("5. STOP works mid-handover, and every message we start checks it");
r = await say(BUYER, "STOP");
assert.equal(r.silent, false, "STOP is answered even while a person has the chat");
assert.equal(bot.isOptedOut(BUYER), true);

const requestsBefore = cloud.templateRequests();
let n = await notifier.orderShipped(orders[0]);
business("shipped notice", n);
assert.equal(n.sent, false);
assert.equal(cloud.templateRequests(), requestsBefore, "suppressed before any request was made");

r = await say(BUYER, "ok thanks");
assert.equal(r.silent, true, "opting out and the handover are separate: the person still has the chat");

r = await say(BUYER, "start");
assert.equal(bot.isOptedOut(BUYER), false);
n = await notifier.orderShipped(orders[0]);
business("shipped notice", n);
assert.equal(n.sent, true);

// ── 6 ─────────────────────────────────────────────────────────────────────
step('6. "menu" is a way out of anything, a handover included');
r = await say(BUYER, "menu");
assert.equal(r.replies[0].kind, "list");
assert.equal(bot.peek(BUYER).handoverUntil, null);
r = await tap(BUYER, "m:track");
assert.equal(r.silent, false, "and the menu it brings back is live");

// A handover nobody ends runs out by itself.
await tap(STRANGER, "m:support");
await tap(STRANGER, "sup:human");
wait(HANDOVER_MS + MIN, "a day and a minute");
r = await say(STRANGER, "anyone?");
assert.equal(r.replies[0].kind, "list", "after 24 hours the bot answers again");

// ── 7 ─────────────────────────────────────────────────────────────────────
step('7. The template gate: unset or unapproved means "send nothing", never an error');
wait(3 * DAY, "3 days"); // nobody has written in since

// Why templates exist at all: free-form text we start is refused outside the window.
const late = await cloud.sendFree(BUYER, { kind: "text", body: "Your order was delivered" }, now);
console.log(`  ${"business".padEnd(8)} * free-form text, 3 days on: refused - ${late.error}`);
assert.equal(late.ok, false);

n = await notifier.orderShipped(orders[0]);
business("shipped notice, 3 days on", n);
assert.equal(n.sent, true, "an approved template reaches them where free text cannot");

const before = cloud.templateRequests();
n = await notifier.orderConfirmed(orders[0]);
business("confirmed notice", n);
assert.equal(n.sent, false);
assert.equal(cloud.templateRequests(), before, "unset: no request at all");

n = await notifier.orderDelivered(orders[1]);
business("delivered notice", n);
assert.equal(n.sent, false);
assert.match(n.reason, /not approved/, "unapproved: refused by the platform, returned, not thrown");

// A variant that carries one more variable is its own approved template, and
// the code has to send that many. Point the gate at it without doing so:
templates.delivered = "demo_order_delivered_v2";
n = await notifier.orderDelivered(orders[1]);
business("delivered notice (3-variable template, 2 sent)", n);
assert.equal(n.sent, false);
assert.match(n.reason, /takes 3 variables, got 2/);

// Best-effort: a status change finishes even when the send blows up.
cloud.setDown(true);
async function markShipped(order) {
  const notice = await notifier.orderShipped(order);
  return { ok: true, notice };
}
const shipped = await markShipped(orders[0]);
business("shipped notice, API unreachable", shipped.notice);
assert.equal(shipped.ok, true, "the order update still completes");
assert.equal(shipped.notice.sent, false);
cloud.setDown(false);

// ── 8 ─────────────────────────────────────────────────────────────────────
step("8. Labels are clipped where the message is built");
const long = listMessage({
  body: "x",
  button: "A button label that is far too long",
  rows: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, title: `Row ${i} with a title well over the limit` })),
});
assert.equal(long.rows.length, LIMITS.rows);
assert.ok(long.rows.every((row) => row.title.length <= LIMITS.title));
assert.ok(long.button.length <= LIMITS.button);
console.log(`  12 rows -> ${long.rows.length}, longest title ${Math.max(...long.rows.map((x) => x.title.length))} chars, button "${long.button}"`);

console.log("\nAll checks passed.");
