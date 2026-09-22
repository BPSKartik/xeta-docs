// The merchant side, simplified: pricing, order records, and the PayU callback.
// Everything lives in memory. A real store would also persist orders, send
// email and hand paid orders to a courier; none of that changes the payment
// logic below.
import { payuEndpoint, configured, requestHash, verifyResponseHash } from "./payu.mjs";

// Illustrative store rules for the demo, not the real store's numbers.
const DELIVERY_FEE = 40;
const FREE_ABOVE = 500;
const MAX_QTY = 10;

export function createStore({ creds, settings = {}, origin = "https://store.example" }) {
  const catalogue = new Map([
    ["steel-bottle", { name: "Steel bottle", price: 349, stock: 5 }],
    ["desk-lamp", { name: "Desk lamp", price: 899, stock: 1 }],
    ["notebook", { name: "A5 notebook", price: 120, stock: 20 }],
  ]);
  const orders = new Map();
  let seq = 0;
  const outbox = []; // receipts a real store would email; here we just collect them

  // The browser sends slug + qty and nothing else is read. A price, total or
  // discount in the request is not rejected, it is simply never looked at, so
  // there is no code path where it could be trusted by accident.
  function priceCart(items) {
    const lines = [];
    for (const it of Array.isArray(items) ? items : []) {
      const p = catalogue.get(String(it?.slug));
      if (!p) continue; // unknown product: dropped, never guessed at
      // Whole units, within a sane range.
      const qty = Math.max(1, Math.min(MAX_QTY, Math.floor(Number(it.qty)) || 1));
      lines.push({ slug: String(it.slug), name: p.name, price: p.price, qty });
    }
    const subtotal = lines.reduce((a, l) => a + l.price * l.qty, 0);
    const delivery = subtotal >= FREE_ABOVE ? 0 : DELIVERY_FEE;
    return { lines, subtotal, delivery, total: subtotal + delivery };
  }

  // All or nothing: returns the lines it could not take, and takes none of
  // them in that case, so a part-filled order never quietly holds units.
  function takeStock(lines) {
    const short = lines.filter((l) => (catalogue.get(l.slug)?.stock ?? 0) < l.qty);
    if (short.length === 0) for (const l of lines) catalogue.get(l.slug).stock -= l.qty;
    return short;
  }

  // The checkout endpoint.
  function placeOrder({ items, billing = {}, method } = {}) {
    const m = method === "online" ? "online" : "cod";
    const cart = priceCart(items);
    if (cart.lines.length === 0) return { status: 400, body: { error: "Cart is empty." } };

    // Tell the buyer an item is gone now, while nothing has been charged.
    const short = cart.lines.filter((l) => catalogue.get(l.slug).stock < l.qty);
    if (short.length) return { status: 409, body: { error: `Out of stock: ${short.map((l) => l.name).join(", ")}` } };

    if (m === "online" && !configured(creds)) {
      return { status: 400, body: { error: "Online payment is unavailable. Please choose cash on delivery." } };
    }

    // A plain counter; nothing here depends on the id's shape.
    const orderId = `demo-order-${++seq}`;
    const name = String(billing.name || "").trim().slice(0, 60);
    const email = String(billing.email || "").trim().slice(0, 120);

    // Cash on delivery is a real order straight away, so it takes stock now
    // and is refused if someone else got there first.
    if (m === "cod") {
      const missed = takeStock(cart.lines);
      if (missed.length) return { status: 409, body: { error: `Out of stock: ${missed.map((l) => l.name).join(", ")}` } };
      orders.set(orderId, { orderId, name, email, ...cart, method: m, status: "placed", paidTime: null, paymentRef: null });
      outbox.push({ orderId, total: cart.total, paid: false });
      return { status: 200, body: { ok: true, orderId, online: false } };
    }

    // An online order is only a placeholder until PayU says it was paid. The
    // callback needs something to find; the buyer should not see it yet.
    orders.set(orderId, {
      orderId, name, email, ...cart, method: m,
      status: "awaiting_payment", paidTime: null, paymentRef: null,
    });

    // The amount is a string and it is hashed exactly as sent. Format it once.
    const amount = cart.total.toFixed(2);
    // udf1 carries the order id and udf5 tags this as a store payment (the
    // same callback also serves subscriptions). Both sit inside the hash.
    const signed = { txnid: orderId, amount, productinfo: "Demo store order", firstname: name, email, udf1: orderId, udf5: "store-order" };
    const callbackUrl = `${origin}/callback`;
    const params = { key: creds.key, ...signed, surl: callbackUrl, furl: callbackUrl, hash: requestHash(creds, signed) };
    return { status: 200, body: { ok: true, orderId, online: true, action: payuEndpoint(settings).paymentUrl, params } };
  }

  // The callback, reached through the buyer's browser. Anyone can
  // POST here, so nothing in the body counts until the reverse hash checks out.
  function handleCallback(formBody) {
    const p = Object.fromEntries(new URLSearchParams(formBody));
    const id = p.udf1 || p.txnid || "";
    const isShop = p.udf5 === "store-order";

    if (!verifyResponseHash(creds, p)) {
      // Nothing is written. The result page says plainly that nothing was paid.
      return redirect(isShop ? `/result?id=${encodeURIComponent(id)}&status=unverified` : "/subscription-result?status=failed");
    }
    // Subscriptions share this callback and are told apart by udf5, which is
    // inside the hash. Their branch is not modelled here.
    if (!isShop) return redirect(`/subscription-result?status=${p.status === "success" ? "paid" : "failed"}`);

    const order = orders.get(id);
    const paid = p.status === "success";

    if (paid && order) {
      // The money has landed: only now does the placeholder become an order.
      Object.assign(order, { status: "confirmed", paidTime: new Date(), paymentRef: p.mihpayid || p.txnid });
      // Stock is taken here rather than at checkout, so a buyer who walks away
      // from PayU never ties up units. If it sold out in between, the money is
      // already ours; confirm anyway and mark the order for someone to sort out.
      const missed = takeStock(order.lines);
      if (missed.length) order.oversold = missed.map((l) => `${l.qty} x ${l.name}`).join(", ");
      outbox.push({ orderId: order.orderId, total: order.total, paid: true, paymentRef: order.paymentRef });
    } else if (!paid && order && order.status === "awaiting_payment") {
      // Cancel the placeholder, but only while it is still unpaid: a failure
      // must never overwrite a payment that already landed.
      order.status = "cancelled";
    }
    return redirect(`/result?id=${encodeURIComponent(id)}&status=${paid ? "paid" : "failed"}`);
  }

  // 303 so the browser follows with a GET and a refresh can't re-POST the result.
  const redirect = (path) => ({ status: 303, location: `${origin}${path}` });

  // What the store's order page lists: COD, or online with the money landed.
  const buyerOrders = () => [...orders.values()].filter((o) => o.method === "cod" || o.paidTime !== null);

  return {
    placeOrder, handleCallback, buyerOrders, outbox,
    order: (id) => orders.get(id),
    stockOf: (slug) => catalogue.get(slug)?.stock,
  };
}
