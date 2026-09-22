# Serving the store at the root of its own domain

Shipped in July 2026; the per-host sitemap and robots.txt followed in September 2026.

## What problem it solves

The store lives inside the corporate site's Next.js app, under `/shop`: one codebase and one account sign-in shared with the rest of the site. It also has its own domain, xetastore.in, where the folder name should not show. A shopper should see `/cart`, not `/shop/cart`.

So one app answers on two hosts with two URL shapes, and nothing the store links to may 404 on either: product pages, the policies in its footer, files at the root.

## How it works

Everything keys on the request's `Host` header.

**1. The proxy.** Next.js 16 renamed middleware to *proxy* (a `proxy.ts` file exporting `proxy`). It runs before the filesystem routes, `public/` included.

```
request
  | matcher excludes _next/static, _next/image, favicon.ico --> proxy not run
  v
host is one of the store's hostnames? ---------------- no --> untouched
  | yes
path is /shop or under /shop/? ---------------------- yes --> untouched
first segment is shared (api, account, privacy, ...)? yes --> untouched
last segment has a file extension? ------------------ yes --> untouched
  |
  v
rewrite:  /  -> /shop    /cart -> /shop/cart    /<slug> -> /shop/<slug>
(query string kept; the address bar still shows the original URL)
```

Client-side navigations fetch the same clean URLs, so the same rule covers them.

**2. A link helper and a base.** A small function maps the host to a base: `""` on the store's domain, `"/shop"` anywhere else. Store links are built as `sl(base, path)`, so one component emits `/cart` on the store's domain and `/shop/cart` on the main one. Server components compute the base from the host; the store layout passes it to a client context, so client components render the same hrefs the server did.

**3. The root layout** checks the same host. On the store's domain it drops the corporate navigation and footer and picks the store's tab icon. The sitemap and robots.txt read it too (below).

An earlier approach, a host-conditioned rewrite in the Next config that mapped only `/`, was dropped: it left every other store link prefixed.

## The decisions that matter

**Rewrite, not redirect.** A redirect would put `/shop/cart` in the address bar, the prefix the domain exists to hide. A rewrite answers `/cart` with the `/shop/cart` page: a 200, no `Location` header.

**The host is the signal, not the path.** After a rewrite the browser shows `/cart` while `/shop/cart` rendered, so a "starts with `/shop`" test cannot spot the store, and Next's docs warn that reading `usePathname()` alongside a rewrite can cause hydration mismatches. "Is this the store?" is answered from the host, on the server.

**Shared pages are matched as whole segments.** The API, sign-in, the policies and a few company pages keep their real paths on both domains. The rest of the corporate site is not served on the store's domain: `/docs` there is read as a product slug and gets the store's not-found page. Matching the list as prefixes would be wrong: a product slugged `apiary-honey` would start with `api` and be sent past the store to a path with no page. Because shared pages work on both domains, the store footer links to plain `/privacy` and `/returns`, and shoppers stay on the store's domain. The cost: each new shared page is added to the list by hand, and the names on it act as reserved words for product slugs.

**Paths ending in a file extension pass through.** The proxy runs before `public/` is consulted, so without this rule a root file such as the store's app icon would be folded into `/shop` and render the store's not-found page instead of the image. The rule cannot swallow a product page, because slugs are generated from product names reduced to lowercase letters, digits and hyphens. It is also what lets `/robots.txt` and `/sitemap.xml` through: the list's `robots` and `sitemap` entries compare whole segments, so they do not match a name with an extension.

**`/shop` paths pass through on the store's domain.** A link that still carries the prefix resolves as it is, never as `/shop/shop/...`.

**`sl("")` is `/`, never the empty string.** An empty `href` means "this page". The header appends `?cat=...` to the storefront link, and `"" + "?cat=home"` would resolve against whichever product page the shopper is on.

**The host check is exact.** The hostname is lowercased and its port dropped, then it must equal one of the store's names. A suffix or substring test would accept lookalike hosts. The host only chooses presentation and navigation (layout, tab icon, link prefix, sitemap and robots, where a sign-in lands); no permission check should read it.

**Sitemap and robots are per host.** One fixed file would have the store's domain advertising the main domain's `/shop/...` URLs. On the store's domain the sitemap lists the root and each active product at `/<slug>`; on the main domain, the corporate pages, `/shop`, and products at `/shop/<slug>`. Each robots.txt names its own sitemap and blocks checkout, orders and admin under that host's prefix. The cost: reading the host makes both routes dynamic, where Next would otherwise cache them. If the product query fails, the sitemap still returns its fixed entries rather than a 500.

## What the demo shows

```
node demos/07-store-on-its-own-domain/demo.mjs
```

`routing.mjs` reimplements the host check, `sl()` and the proxy's choice as a pure function, `decide(host, path)`; `seo.mjs` builds each host's sitemap and robots.txt. Every printed claim is checked with `node:assert`:

1. Host classification, including a rejected lookalike host.
2. A table of requests with the expected action and target.
3. Each rule switched off in turn: `/apiary-honey` leaves the store, `/robots.txt` is folded into it.
4. `sl()` on both hosts reaching the same `/shop` route, and the empty-href trap.
5. Slugs never look like files; a product slugged `privacy` is shadowed on the store's domain.
6. Both hosts' sitemap and robots, and a failing catalogue query.
7. A local server answering one request as a rewrite (200) and as a redirect (308).

## Limits of this demo

- Plain functions instead of Next.js; the base is passed as an argument instead of through React context.
- The local server only imitates a rewrite.
- The sitemap is a URL list with a short page list and no XML or priorities.
- The shared list is a sample. A real one should also be checked when a product slug is created, so a slug cannot collide with a shared name; the demo only detects the collision.
- On the store's domain a store page answers at both `/cart` and `/shop/cart`. The demo does not pick a canonical URL beyond listing only the clean ones in the sitemap.
