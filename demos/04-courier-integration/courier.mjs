// The courier's side of the handover, cut into small functions so each rule can
// be checked without a network. Simplified: a real client also logs in, caches
// a token, and sends a much larger payload.

/**
 * Turns the courier's reply to "create this order" into success or a reason.
 *
 * A 200 only means the request was received. Some rejections come back as a
 * 200 with a complaint in the body, so the one proof of an order is the
 * courier's order id. Anything else is a failure that keeps the courier's own
 * words, so whoever retries can see why.
 */
export function classifyCreateReply({ status, body }) {
  let d = {};
  try { d = JSON.parse(body); } catch { /* not JSON: the raw text becomes the reason */ }
  if (!d || typeof d !== "object") d = {};
  const text = String(body ?? "").slice(0, 120);

  if (status < 200 || status >= 300) {
    return { ok: false, reason: String(d.message ?? `HTTP ${status}: ${text}`) };
  }

  const orderId = String(d.order_id ?? "");
  if (!orderId) {
    return { ok: false, reason: String(d.message ?? `accepted but returned no order id: ${text}`) };
  }
  return { ok: true, orderId, shipmentId: String(d.shipment_id ?? "") };
}

// What a naive client does: trust the status line. Kept only so the
// demo can count the rejections it would have recorded as orders.
export const statusOnly = ({ status }) => ({ ok: status >= 200 && status < 300 });

/**
 * The courier refuses an order without a city and state, and checkout collects
 * neither: one address line and a pincode. So the pincode supplies both, from
 * the courier's own lookup, because the party that validates the address is
 * the one whose answer it will accept.
 */
export async function resolvePlace(pincode, lookup, fallback) {
  // Six digits or don't ask: a malformed pincode can't resolve anything.
  if (!/^\d{6}$/.test(pincode ?? "")) return { ...fallback, from: "fallback" };
  try {
    const p = await lookup(pincode);
    const city = String(p?.city ?? p?.district ?? "");
    const state = String(p?.state ?? "");
    // Half an answer is no answer: the courier rejects an order missing either.
    return city && state ? { city, state, from: "lookup" } : { ...fallback, from: "fallback" };
  } catch {
    return { ...fallback, from: "fallback" };
  }
}

/**
 * The pickup location is not an address but the nickname of one saved in the
 * courier account, and an unknown name gets the order refused. From outside, a
 * typo there looks exactly like an outage.
 *
 * So ask rather than assume: the configured name if the account has it
 * (ignoring case), else the primary address, else the first one listed.
 */
export async function resolvePickup(configured, listPickups) {
  const wanted = configured || "";
  try {
    const saved = await listPickups();
    const names = saved.map((a) => String(a.nickname ?? "")).filter(Boolean);
    if (names.length === 0) return { name: wanted || "Primary", note: "no saved pickups returned" };

    const match = names.find((n) => n.toLowerCase() === wanted.toLowerCase());
    const name = match || String(saved.find((a) => a.primary)?.nickname || names[0]);
    // Say so when the setting was overridden, so a wrong value shows up in a
    // log instead of quietly steering every order somewhere else.
    const note = !match && wanted ? `"${wanted}" is not a saved pickup, using "${name}"` : null;
    return { name, note };
  } catch {
    return { name: wanted || "Primary", note: "pickup list unavailable" };
  }
}

/**
 * A pretend courier with the one quirk that matters here: it answers bad input
 * with a 200 and a message. Every reply is invented, not captured from the real
 * API, and the tracker already speaks the store's own status words.
 */
export function fakeCourier({ pickups, postcodes }) {
  let nextId = 70001;
  const parcels = new Map(); // shipment id -> what the tracker will say
  const courier = {
    down: false, // flip to simulate an outage
    creates: 0, // how many times "create order" was called

    listPickups: async () => pickups,

    lookupPostcode: async (pin) => {
      if (courier.down) throw new Error("postcode service unavailable");
      return postcodes[pin] ?? {};
    },

    async create(p) {
      courier.creates++;
      if (courier.down) return { status: 503, body: "<html>Service Unavailable</html>" };
      if (!pickups.some((a) => a.nickname === p.pickup_location)) {
        return { status: 200, body: JSON.stringify({ message: `Pickup location "${p.pickup_location}" is not a saved address` }) };
      }
      if (!p.billing_city || !p.billing_state) {
        return { status: 200, body: JSON.stringify({ message: "Billing city and state are required" }) };
      }
      const id = nextId++;
      parcels.set(String(id + 20000), { status: null });
      return { status: 200, body: JSON.stringify({ order_id: id, shipment_id: id + 20000, status: "NEW" }) };
    },

    // The tracker's view of a parcel; the demo moves it by hand.
    setParcel: (shipmentId, news) => parcels.set(shipmentId, news),

    async track(shipmentId) {
      if (!parcels.has(shipmentId)) return { ok: false, reason: "HTTP 404: unknown shipment" };
      return { ok: true, ...parcels.get(shipmentId) };
    },
  };
  return courier;
}
