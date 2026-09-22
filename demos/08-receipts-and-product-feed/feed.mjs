// A product feed in the shape Meta's catalogue and Google Merchant Center both
// read: RSS 2.0 with the Google namespace, one <item> per product.

export const G_NS = "http://base.google.com/ns/1.0";

/** Google caps descriptions at 5,000 characters; stay a little under it. */
export const DESCRIPTION_MAX = 4900;

const XML_ESCAPES = { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" };

// XML 1.0 cannot carry most C0 control characters at all, escaped or not. One
// pasted into a description would make the whole file unreadable, so each one
// becomes a space. Tab, newline and carriage return are allowed and kept.
export const xmlForbidden = (cp) =>
  (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || cp === 0xfffe || cp === 0xffff;

const scrub = (s) => Array.from(s, (ch) => (xmlForbidden(ch.codePointAt(0)) ? " " : ch)).join("");

/**
 * Every value that came from a database goes through this, URLs included.
 * One pass with one callback, so "&" can never be escaped twice.
 */
export const esc = (s) => scrub(String(s ?? "")).replace(/[<>&'"]/g, (c) => XML_ESCAPES[c]);

/**
 * For machines: "599.00 INR", an amount and an ISO 4217 code. Never
 * toLocaleString here; "1,499" is for people, not for a feed parser.
 */
export function feedPrice(amount, currency = "INR") {
  if (!Number.isFinite(amount) || amount <= 0) throw new RangeError(`not a price: ${amount}`);
  return `${amount.toFixed(2)} ${currency}`;
}

/**
 * Cut first, escape second. Escaping first and then cutting can slice
 * "&amp;" into "&am", and one broken entity makes the whole file unreadable.
 * Cuts on code points so an emoji is never split in half.
 */
export function clip(text, max = DESCRIPTION_MAX) {
  const chars = Array.from(String(text));
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("");
}

/** Why a product cannot be listed, or null if it can. */
export function whyUnlisted(p) {
  // Meta rejects an item without an image; sending it only to be rejected
  // makes the feed look healthier than it is.
  if (!p.image) return "no image";
  if (!p.name) return "no name";
  if (!(p.price > 0)) return "no price";
  return null;
}

export function feedItem(p, { store, brand }) {
  const inStock = p.stock > 0;
  const desc = clip(p.description || p.name);
  // The catalogue may hold the photo inline as a data URL, which no platform
  // will fetch. The feed only uses it as "has a photo" and always links the
  // store's own image route, a real URL a crawler can download.
  const imageLink = `${store}/img/${p.slug}`;
  // g:price is the regular price and g:sale_price the lower one actually
  // charged, so the platforms can show the discount.
  const onSale = p.mrp && p.mrp > p.price;
  const fields = [
    ["g:id", esc(p.slug)],
    ["g:title", esc(p.name)],
    ["g:description", esc(desc)],
    ["g:link", esc(`${store}/${p.slug}`)],
    ["g:image_link", esc(imageLink)],
    // Out of stock is a state to report, not a reason to vanish.
    ["g:availability", inStock ? "in stock" : "out of stock"],
    ["g:inventory", String(p.stock)],
    ["g:condition", "new"],
    ["g:price", feedPrice(onSale ? p.mrp : p.price)],
    ...(onSale ? [["g:sale_price", feedPrice(p.price)]] : []),
    ["g:brand", esc(brand)],
    ["g:product_type", esc(p.category)],
    // The catalogue has no GTIN or MPN field; say so rather than leave the
    // platform to ask for one on every item.
    ["g:identifier_exists", "no"],
  ];
  return ["    <item>", ...fields.map(([k, v]) => `      <${k}>${v}</${k}>`), "    </item>"].join("\n");
}

/**
 * Builds the whole feed and reports what it left out. Inactive products are
 * simply not for sale; active ones that cannot be listed are "skipped" and
 * counted, so a feed that shrinks says so instead of shrinking quietly.
 */
export function buildFeed(products, { store, brand, title, description }) {
  const skipped = [];
  const listed = [];
  for (const p of products.filter((x) => x.active)) {
    const reason = whyUnlisted(p);
    if (reason) skipped.push({ slug: p.slug, reason });
    else listed.push(p);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="${G_NS}">
  <channel>
    <title>${esc(title)}</title>
    <link>${esc(store)}</link>
    <description>${esc(description)}</description>
${listed.map((p) => feedItem(p, { store, brand })).join("\n")}
  </channel>
</rss>
`;
  return { xml, listed: listed.length, skipped };
}

/** What the HTTP response would carry: the counts travel in headers. */
export function feedResponse(result) {
  return {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "X-Feed-Items": String(result.listed),
      "X-Feed-Skipped": String(result.skipped.length),
      "Cache-Control": "public, max-age=900",
    },
    body: result.xml,
  };
}
