// The decisions behind the receipt PDF, as pure functions.
//
// No PDF library here on purpose: drawing text at coordinates is the easy
// part. What the page is allowed to claim (its title, its date, whether it
// says "paid") is the part worth testing, and it tests fine without a page.

/** The store sells within India, so the buyer's day is India's day. */
export const BUYER_TIME_ZONE = "Asia/Kolkata";

export const DISCLAIMER = "This is a receipt for goods sold, not a tax invoice.";

/**
 * Everything on the document that depends on the tax registration number,
 * decided in one place from one input. There is no separate "isTaxInvoice"
 * flag to forget: the title cannot say more than the number printed under it.
 */
export function documentLabels(gstin) {
  // A whitespace-only value counts as absent: that is a typo, not a registration.
  const id = typeof gstin === "string" ? gstin.trim() : "";
  const taxInvoice = id.length > 0;
  return {
    heading: taxInvoice ? "TAX INVOICE" : "RECEIPT",
    // The PDF's own metadata says the same thing as the page.
    subject: taxInvoice ? "Tax invoice" : "Order receipt",
    sellerLines: taxInvoice ? [`GSTIN ${id}`] : [],
    footer: taxInvoice ? "" : DISCLAIMER,
  };
}

/** The stamp states only what is known: unpaid online is "pending", never "paid". */
export function paymentStamp({ paid, method }) {
  if (paid) return "PAID";
  if (method === "cod") return "CASH ON DELIVERY";
  return "PAYMENT PENDING";
}

/**
 * The date as the buyer lived it. 02:00 in India is still the previous day
 * in UTC, and a server's default clock is usually UTC. The zone is always
 * passed explicitly, so the output never depends on where the code runs.
 */
export function receiptDate(at, timeZone = BUYER_TIME_ZONE) {
  return at.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone });
}

/** For people: Indian digit grouping (1,23,456) and the rupee sign. */
export const rupees = (n) => `₹${n.toLocaleString("en-IN")}`;

// The standard PDF fonts are encoded in WinAnsi, which is essentially
// Windows-1252: Latin-1 plus these extras in 0x80-0x9F. The rupee sign
// (U+20B9) is in neither, so a standard font cannot draw it at all.
const WINANSI_EXTRAS = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** Could a standard (non-embedded) PDF font encode this text? */
export function winAnsiCanEncode(text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const latin1 = (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff);
    if (!latin1 && !WINANSI_EXTRAS.has(ch)) return false;
  }
  return true;
}

/**
 * A plain-text stand-in for the PDF, in the order the real page is laid out.
 * Every date comes from the stored order, never from "now", so a copy
 * rendered later says the same thing as the first one.
 */
export function receiptText(order, { gstin, seller = "Demo Store" } = {}) {
  const labels = documentLabels(gstin);
  const lines = [
    `DEMO STORE${" ".repeat(20)}${labels.heading}`,
    `Order ${order.orderId}`,
    `${receiptDate(order.createdAt)}${" ".repeat(12)}${paymentStamp(order)}`,
    "",
    `SOLD BY  ${[seller, ...labels.sellerLines].join(" / ")}`,
    "",
  ];
  for (const l of order.items) {
    lines.push(`  ${l.name.padEnd(28)} x${l.qty}  ${rupees(l.price * l.qty)}`);
  }
  lines.push(`  Items ${rupees(order.subtotal)} · Delivery ${order.delivery ? rupees(order.delivery) : "Free"} · Total ${rupees(order.total)}`);
  lines.push("");
  if (labels.footer) lines.push(labels.footer);
  return lines.join("\n");
}
