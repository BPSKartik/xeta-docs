// An in-memory stand-in for the orders table, the product shelf and the outbox
// of buyer messages. Every operation yields to the event loop first, so two
// callers interleave the way two HTTP requests hitting one database would.

const tick = () => new Promise((r) => setImmediate(r));

// Delivered and cancelled are the end of the line: no later news reopens them.
export const FINAL = new Set(["delivered", "cancelled"]);

export class Store {
  /** `random`, if given, makes each operation wait 0-3 ticks: a shuffled schedule. */
  constructor({ random } = {}) {
    this.orders = new Map();
    this.shelf = new Map(); // slug -> units on hand
    this.outbox = []; // every message the buyer was sent
    this.random = random;
    this.holds = new Map(); // orderId -> readers made to wait for each other
  }

  async #yield() {
    const n = this.random ? Math.floor(this.random() * 4) : 1;
    for (let i = 0; i < n; i++) await tick();
  }

  /**
   * The next `n` reads of this order wait until all `n` have happened, so every
   * reader holds the same old row before anyone writes. That is the worst case
   * for a race, made to happen instead of hoped for.
   */
  holdReads(orderId, n) {
    this.holds.set(orderId, { n, waiting: [] });
  }

  async read(ref) {
    await this.#yield();
    const row = [...this.orders.values()].find((o) =>
      ref.orderId ? o.orderId === ref.orderId : Boolean(ref.shipmentId) && o.shipmentId === ref.shipmentId,
    );
    if (!row) return null;
    const snapshot = structuredClone(row);
    const hold = this.holds.get(row.orderId);
    if (hold) {
      await new Promise((release) => {
        hold.waiting.push(release);
        if (hold.waiting.length === hold.n) {
          this.holds.delete(row.orderId);
          hold.waiting.forEach((r) => r());
        }
      });
    }
    return snapshot;
  }

  async openShipments() {
    await this.#yield();
    return [...this.orders.values()]
      .filter((o) => o.shipmentId && !FINAL.has(o.status))
      .map((o) => ({ orderId: o.orderId, shipmentId: o.shipmentId }));
  }

  // One SQL statement's worth: UPDATE ... SET data WHERE cond. Nothing awaits
  // between the check and the write, so in single-threaded JS this is as atomic
  // as the row lock it imitates. Returns the number of rows it changed.
  async updateWhere(orderId, cond, data) {
    await this.#yield();
    const row = this.orders.get(orderId);
    if (!row || !cond(row)) return 0;
    Object.assign(row, data);
    return 1;
  }

  // Same shape as a SQL decrement, `WHERE stock >= qty`: the last unit can
  // only be taken once. Returns the lines that could not be taken.
  async takeStock(lines) {
    await this.#yield();
    const short = lines.filter((l) => (this.shelf.get(l.slug) ?? 0) < l.qty);
    if (short.length) return short;
    for (const l of lines) this.shelf.set(l.slug, this.shelf.get(l.slug) - l.qty);
    return [];
  }

  async returnStock(lines) {
    await this.#yield();
    for (const l of lines) this.shelf.set(l.slug, (this.shelf.get(l.slug) ?? 0) + l.qty);
  }
}

/**
 * The one place courier news touches an order. The webhook (pushed) and the
 * sync (pulled) both call it, so there is one definition of "this is new" and
 * one of "now the buyer hears about it".
 *
 * `guard` picks the write's condition. "compare-and-set" also requires the
 * status to still be the one this call read; "terminal-only" guards only the
 * final states. The demo keeps the weaker one only to show what compare-and-set
 * adds.
 */
export async function applyCourierUpdate(store, ref, update, { guard = "compare-and-set" } = {}) {
  const before = await store.read(ref);
  // The courier has no say over an order it was never given.
  if (!before || !before.courierOrderId) return { changed: false, told: false };

  // News the order already has is not news.
  const data = {};
  if (update.awb && update.awb !== before.awb) data.awb = update.awb;
  if (update.courier && update.courier !== before.courier) data.courier = update.courier;
  if (update.status && update.status !== before.status) data.status = update.status;
  if (Object.keys(data).length === 0) return { changed: false, told: false };

  const rows = await store.updateWhere(before.orderId, (row) =>
    Boolean(row.courierOrderId) &&
    !FINAL.has(row.status) &&
    // A transition only applies to the status it was decided from. Whoever
    // gets there second finds the row already moved, and changes nothing.
    (guard !== "compare-and-set" || !data.status || row.status === before.status),
  data);

  // Everything below belongs to whoever actually changed the row, never to
  // whoever merely heard the news.
  if (rows === 0) return { changed: false, told: false };
  const moved = Boolean(data.status);

  // A courier cancellation puts the units back. It rides on the transition, so
  // the same cancellation reported twice cannot return the stock twice.
  if (moved && data.status === "cancelled") await store.returnStock(before.items);

  const worthTelling = moved && (data.status === "shipped" || data.status === "delivered");
  if (!worthTelling) return { changed: true, told: false };

  store.outbox.push({ orderId: before.orderId, status: data.status, awb: data.awb ?? before.awb });
  return { changed: true, told: true };
}

/**
 * Asks the courier about every handed-over parcel not yet finished. Pushed news
 * only comes on courier scans, and silence can't be told apart from a webhook
 * that isn't there, so the store asks too, through the same update path.
 */
export async function syncOpenShipments(store, track, opts) {
  const results = [];
  for (const o of await store.openShipments()) {
    const t = await track(o.shipmentId);
    // One parcel the courier can't answer for must not stop the rest.
    if (!t.ok) { results.push({ orderId: o.orderId, error: t.reason }); continue; }
    const { changed } = await applyCourierUpdate(store, { orderId: o.orderId }, t, opts);
    results.push({ orderId: o.orderId, changed });
  }
  return results;
}
