// One app, two faces. The store's pages live under /shop in the app; on the
// store's own domain they are served at the root, so /cart shows /shop/cart
// while the address bar keeps saying /cart. Every other host is left alone.
//
// Simplified illustration for the docs: plain
// functions over (host, path) so the whole decision can be tested as a table.

export const STORE_HOSTS = ["xetastore.in", "www.xetastore.in"];

// Host headers arrive in any case and sometimes with a port. Compare the bare
// name against an exact list: a suffix or substring test would let a lookalike
// such as "xetastore.in.example.net" pass for the store.
export function isStoreHost(host) {
  const bare = String(host ?? "").toLowerCase().split(":")[0];
  return STORE_HOSTS.includes(bare);
}

// The prefix every store link needs on this host: none on the store's own
// domain, "/shop" everywhere else (xeta.in, previews, localhost).
export function baseForHost(host) {
  return isStoreHost(host) ? "" : "/shop";
}

// Build a store link. The only special case is the storefront itself on its own
// domain: "/" and never "". An empty href means "this page", and "" + "?cat=x"
// would resolve against whatever product page the shopper is on.
export function sl(base, path = "") {
  return `${base}${path}` || "/";
}

// First path segments that are not store pages. They exist once, at their real
// path, and both domains serve them: the API, sign-in, the policies the store
// footer links to, and four company pages. Matched as whole segments, never as
// prefixes, so a product called "apiary-honey" is still a product.
export const SHARED_SEGMENTS = new Set([
  "api", "account", "_next", "favicon", "robots", "sitemap", "manifest",
  "privacy", "terms", "returns", "shipping",
  "about", "careers", "contact", "services",
]);

// Paths the proxy is never even invoked for (the matcher excludes them):
// build output, image optimisation, the favicon.
const NOT_MATCHED = /^\/(_next\/static|_next\/image|favicon\.ico)/;

// A last segment with an extension is a file (an icon, a manifest, robots.txt,
// a verification .txt). Product slugs are [a-z0-9-] only, so no slug can look
// like one.
const HAS_EXTENSION = /\.[a-z0-9]+$/i;

export function firstSegment(pathname) {
  return pathname.split("/")[1] ?? "";
}

/**
 * What the proxy does with one request.
 *
 * Returns { action, to, why } where action is:
 *   "skip"    - the proxy does not run for this path at all
 *   "pass"    - the request continues to the path it asked for
 *   "rewrite" - the request is served from `to`; the browser still shows the original
 *
 * `opts` exists only so the demo can switch a rule off and show what it
 * protects against.
 */
export function decide(host, path, opts = {}) {
  const { wholeSegments = true, fileRule = true } = opts;
  // Split path and query; the query rides along untouched on a rewrite. The
  // path is appended, not resolved, so "//x" stays a path instead of a host.
  const u = new URL("http://placeholder.invalid" + path);
  const { pathname, search } = u;

  if (NOT_MATCHED.test(pathname)) return { action: "skip", to: pathname + search, why: "matcher excludes it" };
  if (!isStoreHost(host)) return { action: "pass", to: pathname + search, why: "not the store host" };

  // Already store-scoped. An old link that still carries /shop keeps working
  // instead of turning into /shop/shop/...
  if (pathname === "/shop" || pathname.startsWith("/shop/")) {
    return { action: "pass", to: pathname + search, why: "already under /shop" };
  }

  const seg = firstSegment(pathname);
  const shared = wholeSegments
    ? SHARED_SEGMENTS.has(seg)
    : [...SHARED_SEGMENTS].some((s) => pathname.startsWith(`/${s}`)); // prefix matching, for contrast
  if (shared) return { action: "pass", to: pathname + search, why: "shared page" };

  if (fileRule && HAS_EXTENSION.test(pathname)) return { action: "pass", to: pathname + search, why: "file with an extension" };

  const to = (pathname === "/" ? "/shop" : `/shop${pathname}`) + search;
  return { action: "rewrite", to, why: "store page" };
}

// Product slugs are lowercase letters, digits and hyphens. That is what makes
// the extension rule safe, and what makes the shared segments reserved words.
export function slugify(name) {
  const s = String(name ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-")
    .slice(0, 50);
  return s || "product";
}

// A slug equal to a shared segment is reachable at /shop/<slug> on xeta.in but
// not at /<slug> on the store's domain, where the shared page wins. This demo
// does not refuse such a slug; it only detects it.
export function shadowedOnStore(slug) {
  return SHARED_SEGMENTS.has(slug);
}
