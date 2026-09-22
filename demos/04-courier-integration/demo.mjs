// Handing orders to a courier without losing them: a walkthrough.
//
//   node demos/04-courier-integration/demo.mjs
//
// All in memory: no network, no database, invented data. The courier is a fake
// that shares one quirk with the real one (it can reject an order with HTTP
// 200), and the "database" is a Map with a conditional update.

import assert from "node:assert/strict";
import { classifyCreateReply, statusOnly, resolvePlace, resolvePickup, fakeCourier } from "./courier.mjs";
import { pushOrder } from "./handover.mjs";
import { Store, applyCourierUpdate, syncOpenShipments } from "./store.mjs";

const step = (t) => console.log(`\n== ${t}`);
const say = (t) => console.log(`   ${t}`);

// Invented account data: two saved pickup addresses and one known pincode.
const pickups = [{ nickname: "Demo Depot", primary: true }, { nickname: "Warehouse B" }];
const postcodes = { "123456": { city: "Demo City", state: "Demo State" } };
const settings = { pickup: "Demo Depot", fallbackPlace: { city: "", state: "" } };

// A confirmed order takes its stock first, then waits for the courier.
async function place(store, orderId, pincode = "123456") {
  const items = [{ slug: "mug", qty: 1 }];
  assert.deepEqual(await store.takeStock(items), [], "the shelf had the unit");
  store.orders.set(orderId, {
    orderId, status: "new", address: "1 Demo Street", pincode, items,
    courierOrderId: null, shipmentId: null, awb: null, courier: null, courierError: null,
  });
  return store.orders.get(orderId);
}

// A fresh store holding one order already with the courier, for the races.
async function oneParcel(random) {
  const store = new Store({ random });
  const courier = fakeCourier({ pickups, postcodes });
  store.shelf.set("mug", 3);
  const order = await place(store, "DEMO-R");
  assert.equal((await pushOrder(store, order.orderId, courier, settings)).ok, true);
  return { store, courier, order };
}
const told = (store, id) => store.outbox.filter((m) => m.orderId === id).length;

// ---------------------------------------------------------------------------
step("1. A 200 is not an order");

const replies = [
  ["200 with an order id    ", { status: 200, body: '{"order_id":70001,"shipment_id":90001}' }, true],
  ["200 with a complaint    ", { status: 200, body: '{"message":"Billing city and state are required"}' }, false],
  ["200 with a bad pickup   ", { status: 200, body: '{"message":"Pickup location \\"Primary\\" is not a saved address"}' }, false],
  ["200 with an empty object", { status: 200, body: "{}" }, false],
  ["200 that isn't JSON     ", { status: 200, body: "OK" }, false],
  ["422 with a message      ", { status: 422, body: '{"message":"Phone must be 10 digits"}' }, false],
  ["503 HTML error page     ", { status: 503, body: "<html>Service Unavailable</html>" }, false],
];
let fooled = 0;
for (const [label, reply, isOrder] of replies) {
  const v = classifyCreateReply(reply);
  if (statusOnly(reply).ok !== isOrder) fooled++;
  say(`${label} -> ${v.ok ? `order ${v.orderId}` : `rejected: ${v.reason}`}`);
  assert.equal(v.ok, isOrder, label);
  if (!v.ok) assert.ok(v.reason.length > 0, "a failure always says why");
}
// The attack on the naive check: rejections dressed up as success.
assert.equal(fooled, 4);
say(`a status-code-only check would have saved ${fooled} of these rejections as orders`);

// ---------------------------------------------------------------------------
step("2. Give the courier the fields it insists on");

const probe = fakeCourier({ pickups, postcodes });
// Two common ways a payload goes wrong, one at a time: a pickup name assumed
// rather than looked up, and a city and state nobody filled in.
const good = { order_id: "DEMO-0", pickup_location: "Demo Depot", billing_city: "Demo City", billing_state: "Demo State" };
for (const [what, patch] of [
  ["assumed pickup name ", { pickup_location: "Primary" }],
  ["blank city and state", { billing_city: "", billing_state: "" }],
]) {
  const reply = await probe.create({ ...good, ...patch });
  assert.equal(reply.status, 200);
  assert.equal(statusOnly(reply).ok, true, "the status line says yes");
  assert.equal(classifyCreateReply(reply).ok, false, "the body says no");
  say(`${what}: HTTP ${reply.status}, but "${classifyCreateReply(reply).reason}"`);
}

let lookups = 0;
const counted = async (pin) => { lookups++; return probe.lookupPostcode(pin); };
const found = await resolvePlace("123456", counted, settings.fallbackPlace);
assert.deepEqual(found, { city: "Demo City", state: "Demo State", from: "lookup" });
say(`pincode 123456 -> ${found.city}, ${found.state} (courier's own lookup)`);

for (const bad of ["12345", "12A456", "", null]) {
  const r = await resolvePlace(bad, counted, settings.fallbackPlace);
  assert.equal(r.from, "fallback");
}
assert.equal(lookups, 1, "a malformed pincode never reaches the lookup");
assert.equal((await resolvePlace("654321", counted, settings.fallbackPlace)).from, "fallback", "no answer, no guess");
say("malformed pincodes are not looked up; unknown ones fall back to the defaults");

const exact = await resolvePickup("demo depot", probe.listPickups);
const typo = await resolvePickup("Primary", probe.listPickups);
const blind = await resolvePickup("Warehouse B", async () => { throw new Error("down"); });
assert.equal(exact.name, "Demo Depot");
assert.equal(typo.name, "Demo Depot", "an unknown name falls back to the primary address");
assert.match(typo.note, /not a saved pickup/);
assert.equal(blind.name, "Warehouse B", "if the list is unavailable, the setting is still tried");
say(`pickup "demo depot" -> "${exact.name}"; "Primary" -> ${typo.note}`);

// ---------------------------------------------------------------------------
step("3. A paid order survives a courier outage");

const store = new Store();
const courier = fakeCourier({ pickups, postcodes });
store.shelf.set("mug", 5);
for (const id of ["DEMO-A", "DEMO-B", "DEMO-C"]) await place(store, id);
assert.equal(store.shelf.get("mug"), 2);

courier.down = true;
const a = store.orders.get("DEMO-A");
const failed = await pushOrder(store, "DEMO-A", courier, settings);
assert.equal(failed.ok, false);
assert.equal(a.courierOrderId, null);
assert.ok(a.courierError, "the reason is stored where a person will see it");
say(`courier down: order kept, reason on it: "${a.courierError}"`);

courier.down = false;
assert.equal((await pushOrder(store, "DEMO-A", courier, settings)).ok, true);
assert.equal(a.courierError, null);
say(`retry: courier order ${a.courierOrderId}, shipment ${a.shipmentId}`);

const calls = courier.creates;
const again = await pushOrder(store, "DEMO-A", courier, settings);
assert.equal(again.ok, false);
assert.equal(courier.creates, calls, "no second courier order for the same parcel");
say(`another retry: refused (${again.reason}) without calling the courier`);

for (const id of ["DEMO-B", "DEMO-C"]) assert.equal((await pushOrder(store, id, courier, settings)).ok, true);

// ---------------------------------------------------------------------------
step("4. Don't wait to be told: pull tracking too");

// A was scanned, but the webhook never came. Only asking finds out.
courier.setParcel(a.shipmentId, { status: "shipped", awb: "DEMO-AWB-1", courier: "Demo Couriers" });
// B has no movement yet, but the courier now knows its tracking number.
const b = store.orders.get("DEMO-B");
courier.setParcel(b.shipmentId, { status: null, awb: "DEMO-AWB-2", courier: "Demo Couriers" });
// C carries a shipment id the tracker has never heard of.
const c = store.orders.get("DEMO-C");
c.shipmentId = "DEMO-UNKNOWN";

const results = await syncOpenShipments(store, courier.track);
say(results.map((r) => `${r.orderId}: ${r.error ? `error (${r.error})` : r.changed ? "changed" : "no change"}`).join("; "));
assert.equal(a.status, "shipped");
assert.equal(b.status, "new");
assert.equal(b.awb, "DEMO-AWB-2", "a tracking number fills in without a status change");
assert.ok(results.find((r) => r.orderId === "DEMO-C").error, "one failure is reported, the loop goes on");
assert.equal(told(store, "DEMO-A"), 1);
assert.equal(told(store, "DEMO-B"), 0, "no transition, no message");

const late = await applyCourierUpdate(store, { shipmentId: a.shipmentId }, { status: "shipped", awb: "DEMO-AWB-1" });
assert.equal(late.changed, false);
assert.equal(told(store, "DEMO-A"), 1);
say("the webhook arrives late with the same news: nothing changes, nobody is told twice");

// ---------------------------------------------------------------------------
step("5. Webhook and sync race on the same event");

// Both read the order while it is still "new", then both apply "shipped".
async function race(guard, status, from = "new") {
  const { store: s, courier: k, order: o } = await oneParcel();
  o.status = from; // where the parcel stood before this news
  const news = { status, awb: "DEMO-AWB-7", courier: "Demo Couriers" };
  k.setParcel(o.shipmentId, news);
  s.holdReads(o.orderId, 2);
  await Promise.all([
    applyCourierUpdate(s, { shipmentId: o.shipmentId }, news, { guard }), // the webhook
    syncOpenShipments(s, k.track, { guard }), // the sync
  ]);
  return { store: s, order: o };
}

const cas = await race("compare-and-set", "shipped");
assert.equal(told(cas.store, "DEMO-R"), 1);
say(`compare-and-set, both saw "new", both apply "shipped": buyer told ${told(cas.store, "DEMO-R")} time`);

const loose = await race("terminal-only", "shipped");
assert.equal(told(loose.store, "DEMO-R"), 2);
say(`terminal-only condition, same race: buyer told ${told(loose.store, "DEMO-R")} times`);

const done = await race("terminal-only", "delivered", "shipped");
assert.equal(told(done.store, "DEMO-R"), 1);
say(`terminal-only condition, both apply "delivered": told ${told(done.store, "DEMO-R")} time (a final state admits one writer)`);

// Now let the scheduler shuffle: webhook, sync and a webhook resend, 200 times.
let seed = 42;
const random = () => { // mulberry32, so every run shuffles the same way
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};
for (let i = 0; i < 200; i++) {
  const { store: s, courier: k, order: o } = await oneParcel(random);
  const news = { status: "shipped", awb: "DEMO-AWB-8", courier: "Demo Couriers" };
  k.setParcel(o.shipmentId, news);
  await Promise.all([
    applyCourierUpdate(s, { shipmentId: o.shipmentId }, news),
    syncOpenShipments(s, k.track),
    applyCourierUpdate(s, { orderId: o.orderId }, news),
  ]);
  assert.equal(o.status, "shipped");
  assert.equal(told(s, o.orderId), 1, `run ${i}: exactly one message`);
}
say("200 shuffled runs of webhook + sync + resend: exactly one message every time");

// ---------------------------------------------------------------------------
step("6. What gets refused, and stock that comes back once");

// Refused: news naming an order the store never handed to the courier.
const local = await place(store, "DEMO-X");
const stray = await applyCourierUpdate(store, { orderId: "DEMO-X" }, { status: "delivered" });
assert.equal(stray.changed, false);
assert.equal(local.status, "new");
say("news for an order never handed to the courier: ignored");

// A cancellation reported by webhook and sync at the same moment.
for (const guard of ["compare-and-set", "terminal-only"]) {
  const { store: s, courier: k, order: o } = await oneParcel();
  const shelf = s.shelf.get("mug");
  k.setParcel(o.shipmentId, { status: "cancelled" });
  s.holdReads(o.orderId, 2);
  await Promise.all([
    applyCourierUpdate(s, { shipmentId: o.shipmentId }, { status: "cancelled" }, { guard }),
    syncOpenShipments(s, k.track, { guard }),
  ]);
  assert.equal(o.status, "cancelled");
  assert.equal(s.shelf.get("mug"), shelf + 1, `${guard}: the unit goes back exactly once`);
  say(`${guard}: courier cancellation reported twice at once, mug stock ${shelf} -> ${s.shelf.get("mug")}`);

  // Refused: a late "shipped" trying to reopen the cancelled order.
  const zombie = await applyCourierUpdate(s, { orderId: o.orderId }, { status: "shipped", awb: "DEMO-AWB-9" }, { guard });
  assert.equal(zombie.changed, false);
  assert.equal(o.status, "cancelled");
  assert.equal(told(s, o.orderId), 0);
}
say('a late "shipped" for a cancelled order: refused, nobody told');

console.log("\nAll checks passed.");
