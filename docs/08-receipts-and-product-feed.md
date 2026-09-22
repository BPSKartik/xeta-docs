# PDF receipts and the product feed Meta and Google read

Xeta Store (xetastore.in) produces two documents read away from the site: a PDF receipt for the buyer and an XML product feed for the shopping platforms. Shipped in July 2026.

## What problem it solves

**Receipts.** A confirmation that exists only as an email body is hard to keep or hand to an accountant. The store renders a PDF, attaches it to the confirmation email, and serves it again from a per-order link that needs no login (see [03-signed-links](03-signed-links.md)).

**The feed.** Facebook Shop, Instagram shopping and WhatsApp ordering all read one Meta catalogue; Google Merchant Center reads its own. Without a feed, every price or stock change is retyped on each. Both accept RSS 2.0 with Google's `g:` namespace, so one feed URL serves both.

## How it works

```
cash on delivery: order placed ──┐
online: payment confirmed ───────┴─> render PDF (pdf-lib)
                                       │ fails -> email still goes, without attachment
                                       v
                           email: summary + PDF + download link
                                       │ fails -> logged; the order still stands
later: link -> verify -> re-render from the stored order -> PDF (private, no-store)
```

The PDF is drawn directly with pdf-lib, so no headless browser has to start inside a serverless function. A faint store mark on every page means a forwarded second page still says who sold it.

The feed endpoint reads active products, skips any without an image, a name or a positive price, and writes one `<item>` per remaining product. Each carries what the platforms need to list it: `g:id` (the slug), `g:title`, `g:description` (the name when empty), `g:link` to the product page, `g:image_link`, `g:availability` and `g:price`. The catalogue may hold a photo as a data URL, which no platform fetches, so `g:image_link` always points at the store's image route. It also sends `g:inventory`, `g:condition`, `g:brand`, `g:product_type`, and `g:identifier_exists` set to `no`, since the catalogue holds no GTIN or MPN. The response may be cached publicly for 15 minutes.

## The decisions that matter

**A document must not claim more than the business can back.** Without a GSTIN (GST registration number) in a server-side setting, the PDF is titled "Receipt" and its footer says it is not a tax invoice. That one setting flips four things together: the heading, the PDF metadata subject, a `GSTIN ...` line in the seller block, and the footer. With no separate "tax invoice" flag, the page cannot say "Tax Invoice" without the registration printed on it. The flip changes wording only; what a tax invoice must contain is a question for an accountant.

**The payment stamp is a claim too.** It reads `PAID`, `CASH ON DELIVERY` or `PAYMENT PENDING`; an online order whose money has not landed is pending. Downloads are never publicly cached, because a receipt changes when the payment lands.

**The date is the buyer's, not the server's.** Servers usually run in UTC, so an order placed at 2 a.m. in India would print the previous day on its own receipt. Formatting is pinned to `Asia/Kolkata`. The store ships only within India, so that is the buyer's zone; it is not detected per buyer. Every copy is dated from the stored order, never from the moment it is rendered or sent, so a checkout that straddles midnight does not produce two copies with different dates.

**The rupee sign needs a real font.** The standard PDF fonts use WinAnsi encoding, which has no ₹, and pdf-lib throws rather than drop it. A Lato subset (SIL Open Font License) ships inside the code as base64, because a serverless bundle only reliably includes what the code imports.

**The receipt never fails the order.** A render failure costs the attachment, not the email; a send failure is logged and the order stands. The PDF is attached, not only linked, so it opens offline.

**People get ₹1,499; parsers get `1499.00 INR`.** The receipt uses Indian digit grouping and the symbol. The feed sends a plain amount and an ISO 4217 currency code.

**Leave out what will be rejected, and say so.** Meta rejects an item without an image, and a half-rejected feed is harder to debug than an honest one. Skipped products are counted in a response header, so a shrinking feed does not look like a working one. Out-of-stock products stay listed as `out of stock`.

**Escape every text field, and cut before escaping.** Names, descriptions, categories and slugs are escaped for XML's five special characters, in one pass. One raw `&` in a name makes the whole file unreadable. Markup is worse: a description ending `</g:description><g:price>1.00 INR</g:price><g:description>` leaves the file well-formed and adds a second price. Descriptions are cut to 4,900 characters, under Google's 5,000, before escaping, so `&amp;` is never sliced into `&am`.

## What the demo shows

```
node demos/08-receipts-and-product-feed/demo.mjs
```

Node 20+, no dependencies. `receipt.mjs` holds the receipt decisions as pure functions, `feed.mjs` builds a feed from five invented products, and `xmlcheck.mjs` reads it back as a strict consumer would. The script asserts that the title never outruns the GSTIN line (a blank setting does not count), that a 20:30 UTC order prints India's date and every copy is dated from the stored order, that ₹ is not encodable in WinAnsi, and that the imageless product is skipped and counted while the out-of-stock one stays listed. Its attack cases: an unescaped `&` breaks the file, an unescaped description injects a second price, a control character breaks it even when escaped, and escaping before cutting breaks an entity. The demo's own feed reads back exactly.

## Limits of the demo

It is simplified: there is no PDF drawing, email, signed link, database or HTTP server; the receipt is a plain-text stand-in and the feed response is a plain object. `xmlcheck.mjs` is not a general XML parser (no DTDs, CDATA or comments), only enough to read this feed back strictly. The five products are invented, and the tax-invoice branch is exercised only with an obviously fake registration value; the demo does not check what a real tax invoice must contain.
