// Receipts and the product feed: a runnable walkthrough.
//
//   node demos/08-receipts-and-product-feed/demo.mjs
//
// Part 1 checks what a receipt is allowed to claim, which date it prints, and
// why the rupee sign needs an embedded font. Part 2 builds a small product
// feed, reads it back like a strict consumer would, and shows what an
// unescaped feed lets a product name or description do.
// Every claim printed here is also checked with assert; exit code 0 = all held.

import assert from "node:assert/strict";
import {
  documentLabels, paymentStamp, receiptDate, receiptText, rupees, winAnsiCanEncode, DISCLAIMER,
} from "./receipt.mjs";
import { buildFeed, feedItem, feedPrice, feedResponse, esc, DESCRIPTION_MAX } from "./feed.mjs";
import { readFeed } from "./xmlcheck.mjs";

const say = (s = "") => console.log(s);
const ok = (s) => console.log(`  ok  ${s}`);
const section = (s) => { say(); say(s); say("-".repeat(s.length)); };

// Obviously fake: the demo never needs a real registration number.
const DEMO_GSTIN = "DEMO-GSTIN-NOT-REAL";

// ─── Part 1: the receipt ────────────────────────────────────────────────────

section("1. What the receipt calls itself");

const noId = documentLabels(undefined);
assert.equal(noId.heading, "RECEIPT");
assert.equal(noId.subject, "Order receipt");
assert.equal(noId.footer, DISCLAIMER);
assert.deepEqual(noId.sellerLines, []);
ok(`no GSTIN configured    -> "${noId.heading}", footer: "${noId.footer}"`);

const withId = documentLabels(DEMO_GSTIN);
assert.equal(withId.heading, "TAX INVOICE");
assert.deepEqual(withId.sellerLines, [`GSTIN ${DEMO_GSTIN}`]);
assert.equal(withId.footer, "");
ok(`GSTIN configured       -> "${withId.heading}", seller block adds "${withId.sellerLines[0]}"`);

// Failure case: a setting that is present but blank must not earn the title.
for (const junk of ["", "   ", null]) {
  assert.equal(documentLabels(junk).heading, "RECEIPT");
}
ok(`blank/whitespace GSTIN -> still "RECEIPT" (a typo is not a registration)`);

// The invariant, checked on the rendered text rather than on the labels: no
// document says "TAX INVOICE" unless the number that backs it is on the page,
// and every document without one says what it is not.
const order = {
  orderId: "DEMO-0001",
  createdAt: new Date("2026-07-29T20:30:00Z"),
  items: [{ name: "Steel bottle, 1 L", price: 599, qty: 2 }],
  subtotal: 1198, delivery: 0, total: 1198,
  method: "online", paid: true,
};
for (const gstin of [undefined, "", "  ", DEMO_GSTIN]) {
  const text = receiptText(order, { gstin });
  if (text.includes("TAX INVOICE")) assert.match(text, /GSTIN \S+/);
  else assert.ok(text.includes(DISCLAIMER));
}
ok("across all inputs, the title never claims more than the page can back");

section("2. Which day the order happened");

// 20:30 UTC on 29 July is 02:00 on 30 July in India.
const placed = order.createdAt;
const buyerDay = receiptDate(placed);
const serverDay = receiptDate(placed, "UTC");
assert.equal(buyerDay, "30 July 2026");
assert.equal(serverDay, "29 July 2026");
ok(`order at ${placed.toISOString()} -> receipt says "${buyerDay}"`);
ok(`formatted on a UTC server clock it would say "${serverDay}", the wrong day`);

// A checkout started at 23:58 in India and paid at 00:01 straddles midnight.
// If one copy is dated from the stored order and another from "now", the two
// copies of the same receipt disagree. The demo dates every copy from the order.
const lateOrder = { ...order, orderId: "DEMO-0002", createdAt: new Date("2026-07-30T18:28:00Z") };
const paidAt = new Date("2026-07-30T18:31:00Z");
assert.equal(receiptDate(lateOrder.createdAt), "30 July 2026");
assert.equal(receiptDate(paidAt), "31 July 2026");
// receiptText takes no clock: the only date it can print is the order's own.
const lateCopy = receiptText(lateOrder);
assert.ok(lateCopy.includes("30 July 2026") && !lateCopy.includes("31 July 2026"));
ok(`order started 23:58, paid 00:01: dated from the order it is "${receiptDate(lateOrder.createdAt)}" on every copy`);
ok(`dated from the send time instead, one copy would say "${receiptDate(paidAt)}"`);

section("3. What it says about payment, and in which characters");

assert.equal(paymentStamp({ paid: true, method: "online" }), "PAID");
assert.equal(paymentStamp({ paid: false, method: "cod" }), "CASH ON DELIVERY");
assert.equal(paymentStamp({ paid: false, method: "online" }), "PAYMENT PENDING");
ok('an online order whose payment has not landed says "PAYMENT PENDING", not "PAID"');

assert.equal(rupees(123456), "₹1,23,456");
ok(`amounts for people use Indian grouping and the rupee sign: ${rupees(123456)}`);

// Failure case: the standard PDF fonts cannot encode the rupee sign at all.
assert.equal(winAnsiCanEncode(rupees(1198)), false);
assert.equal(winAnsiCanEncode("Rs 1,198"), true);
assert.equal(winAnsiCanEncode("Total — Free · €"), true);
ok(`"${rupees(1198)}" is not encodable in WinAnsi; only "Rs 1,198" would be, hence an embedded font`);

say();
say("  The receipt, as text (no GSTIN configured):");
say(receiptText(order).split("\n").map((l) => `    | ${l}`).join("\n"));

// ─── Part 2: the product feed ───────────────────────────────────────────────

section("4. Building the feed");

const STORE = "https://store.example";
// The catalogue can store a photo inline. These stand-ins are deliberately
// tiny and fake; all that matters is that a data URL is not a link.
const PHOTO = "data:image/jpeg;base64,DEMO";
// A vertical tab, built from its code point so this file stays plain text.
const VT = String.fromCharCode(0x0b);
const products = [
  { slug: "steel-bottle", name: "Steel bottle, 1 L", description: "Double-walled, keeps water cold.",
    category: "Kitchen", price: 599, mrp: 799, stock: 12, active: true, image: PHOTO },
  // A hostile description: if it reached the XML unescaped it would close the
  // description early and add a second, much cheaper price.
  { slug: "tea-gift-box", name: `Tea & Biscuits <Gift> "Box"`,
    description: `Assam tea.</g:description><g:price>1.00 INR</g:price><g:description>`,
    category: "Food & Drink", price: 450, mrp: null, stock: 4, active: true, image: PHOTO },
  // A description pasted from somewhere else, carrying a vertical tab.
  { slug: "brass-diya-pair", name: "Brass diya (pair)", description: `Hand-polished.${VT}Set of two.`,
    category: "Home", price: 349, mrp: null, stock: 0, active: true,
    image: "https://cdn.example/diya.jpg" },
  { slug: "cotton-tote", name: "Cotton tote", description: "Plain, sturdy.",
    category: "Bags", price: 199, mrp: null, stock: 30, active: true, image: null },
  { slug: "old-lamp", name: "Discontinued lamp", description: "",
    category: "Home", price: 999, mrp: null, stock: 2, active: false, image: PHOTO },
];

const feed = buildFeed(products, {
  store: STORE, brand: "Demo Store",
  title: "Demo Store", description: "Sample products for a feed walkthrough.",
});
const res = feedResponse(feed);
say(res.body.trimEnd().split("\n").map((l) => `    ${l}`).join("\n"));
say();

const parsed = readFeed(res.body);
assert.ok(parsed.ok, parsed.problems.join("; "));
ok("the feed is well-formed");

assert.equal(parsed.items.length, 3);
assert.equal(res.headers["X-Feed-Items"], "3");
assert.equal(res.headers["X-Feed-Skipped"], "1");
assert.deepEqual(feed.skipped, [{ slug: "cotton-tote", reason: "no image" }]);
ok("3 listed; the tote has no photo, so it is skipped and counted in X-Feed-Skipped: 1");
ok("the inactive lamp is not for sale, so it is neither listed nor counted");

const [bottle, tea, diya] = parsed.items;
assert.deepEqual(bottle["g:price"], ["799.00 INR"]);
assert.deepEqual(bottle["g:sale_price"], ["599.00 INR"]);
assert.equal(tea["g:sale_price"], undefined);
ok("price carries a currency; a discounted item pairs g:price (regular) with g:sale_price (charged)");

assert.equal(feedPrice(1499), "1499.00 INR");
assert.ok(!/[,₹]/.test(res.body.match(/<g:price>[^<]*/g).join("")));
ok(`for machines, no grouping and no symbol: ${feedPrice(1499)}, where a person reads ${rupees(1499)}`);

assert.deepEqual(diya["g:availability"], ["out of stock"]);
assert.deepEqual(diya["g:inventory"], ["0"]);
ok('stock 0 -> listed as "out of stock", not dropped');

assert.deepEqual(bottle["g:image_link"], [`${STORE}/img/steel-bottle`]);
assert.deepEqual(diya["g:image_link"], [`${STORE}/img/brass-diya-pair`]);
assert.ok(!res.body.includes("data:"), "a stored data URL leaked into the feed");
ok("g:image_link is always the store's image route; the stored photo itself never enters the feed");

section("5. Escaping, and what happens without it");

assert.deepEqual(tea["g:title"], [products[1].name]);
assert.deepEqual(tea["g:price"], ["450.00 INR"]);
assert.equal(tea["g:description"].length, 1);
assert.equal(tea["g:description"][0], products[1].description);
ok("escaped: the tea box reads back with its exact name, one description and one price (450.00 INR)");

// The attack: the same item built by string concatenation with no escaping.
const naive = (p) => `<rss><channel><item>
  <g:title>${p.name}</g:title>
  <g:description>${p.description}</g:description>
  <g:price>${p.price}.00 INR</g:price>
</item></channel></rss>`;

// (a) An ampersand in a product name breaks the whole file, not just one item.
const brokenByName = readFeed(naive(products[1]));
assert.equal(brokenByName.ok, false);
ok(`unescaped "&" in a name -> rejected: ${brokenByName.problems[0]}`);

// (b) A description with no "&" at all is well-formed and still wrong: it
// smuggles in a second price that a consumer may read instead of the real one.
const sneaky = { ...products[1], name: "Tea gift box" };
const injected = readFeed(naive(sneaky));
assert.equal(injected.ok, true);
assert.deepEqual(injected.items[0]["g:price"], ["1.00 INR", "450.00 INR"]);
const safe = readFeed(`<rss><channel>${feedItem(sneaky, { store: STORE, brand: "Demo Store" })}</channel></rss>`);
assert.deepEqual(safe.items[0]["g:price"], ["450.00 INR"]);
ok("unescaped description -> well-formed XML with two prices (1.00 and 450.00); escaped -> one");

// (c) Escaping alone does not save a control character: XML 1.0 forbids it
// outright, raw or as a character reference, so it has to be removed.
const ENTITIES = { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" };
const escapeOnly = (s) => String(s).replace(/[<>&'"]/g, (c) => ENTITIES[c]);
const brokenByControl = readFeed(`<item><g:description>${escapeOnly(products[2].description)}</g:description></item>`);
assert.equal(brokenByControl.ok, false);
assert.deepEqual(diya["g:description"], ["Hand-polished. Set of two."]);
ok(`a pasted vertical tab -> rejected (${brokenByControl.problems[0]}); esc() turns it into a space`);

section("6. Cut first, then escape");

// A long description with ampersands right at the cut point.
const long = "a".repeat(DESCRIPTION_MAX - 2) + "&&&&";
const cutThenEscape = esc(Array.from(long).slice(0, DESCRIPTION_MAX).join(""));
const escapeThenCut = esc(long).slice(0, DESCRIPTION_MAX);
const wrap = (d) => `<item><g:description>${d}</g:description></item>`;

const good = readFeed(wrap(cutThenEscape));
assert.ok(good.ok);
assert.equal(good.items[0]["g:description"][0].length, DESCRIPTION_MAX);
ok(`cut to ${DESCRIPTION_MAX} characters, then escape -> well-formed, exactly ${DESCRIPTION_MAX} characters`);

const bad = readFeed(wrap(escapeThenCut));
assert.equal(bad.ok, false);
ok(`escape, then cut -> "...${escapeThenCut.slice(-6)}" ends mid-entity and is rejected`);

say();
say("All checks passed.");
