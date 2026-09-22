import { classifyCreateReply, resolvePickup, resolvePlace } from "./courier.mjs";

/**
 * Pushes one order to the courier and records the outcome on it. Never throws:
 * the buyer has already paid, so a courier outage should leave a readable
 * reason and a retry, not a lost order or a crashed request.
 *
 * Simplified: the real payload also carries the items, the buyer's contact
 * details, the payment method and the parcel's size and weight.
 */
export async function pushOrder(store, orderId, courier, settings) {
  const o = store.orders.get(orderId);
  if (!o) return { ok: false, reason: "no such order" };
  // A second courier order for the same parcel is worse than none, so once the
  // courier has given us an id there is nothing left to retry.
  if (o.courierOrderId) return { ok: false, reason: "already with the courier" };

  const [place, pickup] = await Promise.all([
    resolvePlace(o.pincode, courier.lookupPostcode, settings.fallbackPlace),
    resolvePickup(settings.pickup, courier.listPickups),
  ]);

  const payload = {
    order_id: o.orderId,
    pickup_location: pickup.name,
    billing_address: o.address,
    billing_pincode: o.pincode,
    billing_city: place.city,
    billing_state: place.state,
  };

  let verdict;
  try {
    verdict = classifyCreateReply(await courier.create(payload));
  } catch (e) {
    verdict = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }

  // The reason is kept on the order, not just logged: it should be readable
  // next to the retry button, not in a log nobody is watching.
  await store.updateWhere(orderId, () => true, verdict.ok
    ? { courierOrderId: verdict.orderId, shipmentId: verdict.shipmentId, courierError: null }
    : { courierError: verdict.reason.slice(0, 300) });

  return { ...verdict, pickupNote: pickup.note };
}
