// sitemap.xml and robots.txt for an app that answers on two domains.
//
// One fixed file would have the store's domain advertising the other domain's
// /shop/... URLs. Both are built per request from the host instead, with the
// same base and sl() the pages use. Simplified: URL strings only, no priorities,
// change frequencies or XML.

import { isStoreHost, baseForHost, sl } from "./routing.mjs";

const originFor = (host) => (isStoreHost(host) ? "https://xetastore.in" : "https://xeta.in");

// A short sample corporate page list.
const CORPORATE = ["", "/services", "/about", "/contact", "/privacy", "/terms"];

/**
 * `loadSlugs` stands in for the catalogue query (active products only). If it
 * fails, the file loses its product entries rather than failing as a whole.
 */
export async function sitemapFor(host, loadSlugs) {
  const store = isStoreHost(host);
  const origin = originFor(host);
  const base = baseForHost(host);

  const slugs = await Promise.resolve().then(loadSlugs).catch(() => []);
  const products = slugs.map((slug) => `${origin}${sl(base, `/${slug}`)}`);

  // The store's domain lists the store and nothing else: its root and its
  // products, at their clean paths.
  if (store) return [`${origin}/`, ...products];

  return [...CORPORATE.map((p) => `${origin}${p || "/"}`), `${origin}/shop`, ...products];
}

export function robotsFor(host) {
  const origin = originFor(host);
  const base = baseForHost(host);
  const disallow = [
    "/api/",
    "/account/",
    // Nothing to index here: checkout, a shopper's orders, admin. Same pages,
    // different prefix per host, so each domain blocks the path it serves.
    sl(base, "/checkout"),
    sl(base, "/orders"),
    sl(base, "/admin"),
  ];
  return [
    "User-Agent: *",
    "Allow: /",
    ...disallow.map((d) => `Disallow: ${d}`),
    "",
    `Host: ${origin}`,
    `Sitemap: ${origin}/sitemap.xml`,
  ].join("\n");
}
