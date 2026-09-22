// One Next.js app, two domains: the rewrite decision, sl(), and the per-host
// sitemap and robots, as pure functions checked against a table of cases.
// Run from the repo root:  node demos/07-store-on-its-own-domain/demo.mjs
//
// Zero dependencies. Every claim printed below is checked with node:assert;
// a failed check exits non-zero. The last section starts a throwaway server on
// 127.0.0.1 only, to show a rewrite next to a redirect.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  decide,
  isStoreHost,
  baseForHost,
  sl,
  slugify,
  shadowedOnStore,
  SHARED_SEGMENTS,
} from "./routing.mjs";
import { sitemapFor, robotsFor } from "./seo.mjs";

const STORE = "xetastore.in";
const CORP = "xeta.in";

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
}
const section = (title) => console.log(`\n${title}`);

function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (vals) => "  " + vals.map((v, i) => String(v).padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(cols));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

// ---------------------------------------------------------------------------
section("1. Which requests belong to the store's domain");

const hosts = [
  ["xetastore.in", true],
  ["www.xetastore.in", true],
  ["XetaStore.IN:443", true], // case and port are noise
  ["xeta.in", false],
  ["localhost:3000", false], // dev and preview hosts see the plain /shop app
  ["shop.xetastore.in", false], // not on the list, not the store
  ["xetastore.in.example.net", false], // lookalike: a suffix test would say yes
  ["", false],
];
table(hosts.map(([h, want]) => ({ host: h || "(missing)", store: isStoreHost(h), base: JSON.stringify(baseForHost(h)) })), ["host", "store", "base"]);
check("only the two exact store hostnames count, in any case, with any port", () => {
  for (const [h, want] of hosts) assert.equal(isStoreHost(h), want, h);
});
check("a missing Host header falls back to the /shop base, not the store's", () => {
  assert.equal(baseForHost(undefined), "/shop");
});

// ---------------------------------------------------------------------------
section("2. The rewrite decision, one row per request");

const cases = [
  // host, path, expected action, expected target
  [STORE, "/", "rewrite", "/shop"],
  [STORE, "/?cat=home", "rewrite", "/shop?cat=home"],
  [STORE, "/ceramic-mug", "rewrite", "/shop/ceramic-mug"],
  [STORE, "/cart", "rewrite", "/shop/cart"],
  [STORE, "/orders", "rewrite", "/shop/orders"],
  [STORE, "/apiary-honey", "rewrite", "/shop/apiary-honey"], // starts with "api", still a product
  [STORE, "/shipping-box", "rewrite", "/shop/shipping-box"], // starts with "shipping", still a product
  [STORE, "/shopping-bag", "rewrite", "/shop/shopping-bag"], // starts with "shop", still a product
  [STORE, "/docs", "rewrite", "/shop/docs"], // corporate, not shared: the store's not-found
  [STORE, "/shop/cart", "pass", "/shop/cart"],
  [STORE, "/privacy", "pass", "/privacy"],
  [STORE, "/account", "pass", "/account"],
  [STORE, "/api/example", "pass", "/api/example"],
  [STORE, "/robots.txt", "pass", "/robots.txt"],
  [STORE, "/sitemap.xml", "pass", "/sitemap.xml"],
  [STORE, "/app-icon.png", "pass", "/app-icon.png"],
  [STORE, "/_next/static/chunks/app.js", "skip", "/_next/static/chunks/app.js"],
  [STORE, "/favicon.ico", "skip", "/favicon.ico"],
  ["www.xetastore.in", "/cart", "rewrite", "/shop/cart"],
  [CORP, "/", "pass", "/"],
  [CORP, "/shop/ceramic-mug", "pass", "/shop/ceramic-mug"],
  [CORP, "/ceramic-mug", "pass", "/ceramic-mug"], // xeta.in is never touched
  ["xetastore.in.example.net", "/cart", "pass", "/cart"],
];
table(
  cases.map(([host, path]) => ({ host, path, ...decide(host, path) })),
  ["host", "path", "action", "to", "why"],
);
check(`all ${cases.length} rows match the expected action and target`, () => {
  for (const [host, path, action, to] of cases) {
    const d = decide(host, path);
    assert.equal(d.action, action, `${host}${path}`);
    assert.equal(d.to, to, `${host}${path}`);
  }
});
check("no host outside the store list is ever rewritten", () => {
  for (const [host, path] of cases) {
    if (!isStoreHost(host)) assert.notEqual(decide(host, path).action, "rewrite", `${host}${path}`);
  }
});

// ---------------------------------------------------------------------------
section("3. What each rule protects against (switch it off and watch it break)");

const prefixed = decide(STORE, "/apiary-honey", { wholeSegments: false });
console.log(`  prefix matching:  /apiary-honey  -> ${prefixed.action} (${prefixed.why})`);
check("matching shared names as prefixes would hand a product to a route that does not exist", () => {
  assert.equal(prefixed.action, "pass"); // served at /apiary-honey, where nothing lives
  assert.equal(decide(STORE, "/apiary-honey").action, "rewrite");
  assert.equal(decide(STORE, "/shipping-box", { wholeSegments: false }).action, "pass");
});

const noFileRule = decide(STORE, "/robots.txt", { fileRule: false });
console.log(`  no file rule:     /robots.txt    -> ${noFileRule.action} to ${noFileRule.to}`);
check("without the file rule, root files are folded into the store and hit its 404", () => {
  assert.equal(noFileRule.to, "/shop/robots.txt");
  assert.equal(decide(STORE, "/app-icon.png", { fileRule: false }).to, "/shop/app-icon.png");
});
check('"robots" on the shared list does not cover robots.txt: segments are compared whole', () => {
  assert.ok(SHARED_SEGMENTS.has("robots"));
  assert.ok(!SHARED_SEGMENTS.has("robots.txt"));
  // So it is the extension rule, not the list, that lets robots.txt and sitemap.xml through.
  assert.equal(decide(STORE, "/sitemap.xml", { fileRule: false }).action, "rewrite");
});
check("an old /shop link on the store domain is served as-is, never doubled", () => {
  for (const p of ["/shop", "/shop/cart", "/shop/ceramic-mug?ref=old"]) {
    const d = decide(STORE, p);
    assert.equal(d.action, "pass");
    assert.ok(!d.to.startsWith("/shop/shop"), d.to);
  }
});

// ---------------------------------------------------------------------------
section("4. sl(): one component, correct links on both hosts");

const paths = ["", "/cart", "/orders", "/ceramic-mug"];
table(
  paths.map((p) => ({ path: JSON.stringify(p), "on xetastore.in": sl(baseForHost(STORE), p), "on xeta.in": sl(baseForHost(CORP), p) })),
  ["path", "on xetastore.in", "on xeta.in"],
);
check("a link built on either host lands on the same /shop route", () => {
  for (const p of paths) {
    const route = sl("/shop", p);
    const fromStore = decide(STORE, sl(baseForHost(STORE), p));
    const fromCorp = decide(CORP, sl(baseForHost(CORP), p));
    assert.equal(fromStore.to, route, `store link for ${JSON.stringify(p)}`);
    assert.equal(fromCorp.to, route, `corporate link for ${JSON.stringify(p)}`);
  }
});
check("the same holds with a query string appended to the storefront link", () => {
  const q = "?cat=home";
  assert.equal(decide(STORE, sl("") + q).to, "/shop" + q);
  assert.equal(decide(CORP, sl("/shop") + q).to, "/shop" + q);
});

const onProductPage = "https://xetastore.in/ceramic-mug";
const naive = new URL("" + "?cat=home", onProductPage).href;
const built = new URL(sl("") + "?cat=home", onProductPage).href;
console.log(`  from ${onProductPage}:`);
console.log(`    href "?cat=home"   -> ${naive}`);
console.log(`    href "/?cat=home"  -> ${built}`);
check('sl("") is "/", because an empty base would resolve against the current page', () => {
  assert.equal(sl(""), "/");
  assert.equal(naive, "https://xetastore.in/ceramic-mug?cat=home"); // wrong page
  assert.equal(built, "https://xetastore.in/?cat=home"); // the storefront
});

// ---------------------------------------------------------------------------
section("5. Product slugs against the file rule and the shared names");

const names = ["Ceramic Mug", "Steel Bottle 1.5L", "Hair Oil v2.0", "  --Odd__Name!! ", "", "Privacy"];
table(
  names.map((n) => {
    const slug = slugify(n);
    return { name: JSON.stringify(n), slug, "on xetastore.in": decide(STORE, `/${slug}`).action, shadowed: shadowedOnStore(slug) };
  }),
  ["name", "slug", "on xetastore.in", "shadowed"],
);
check("slugs are [a-z0-9-] only, so no slug is mistaken for a file", () => {
  for (const n of names) {
    const slug = slugify(n);
    assert.match(slug, /^[a-z0-9-]+$/);
    assert.ok(!/\.[a-z0-9]+$/i.test(`/${slug}`), slug);
  }
});
check('a product slugged "privacy" is shadowed on the store domain (detected, not prevented)', () => {
  assert.ok(shadowedOnStore(slugify("Privacy")));
  assert.equal(decide(STORE, "/privacy").why, "shared page"); // the policy wins
  assert.equal(decide(CORP, "/shop/privacy").to, "/shop/privacy"); // still reachable here
});

// ---------------------------------------------------------------------------
section("6. sitemap.xml and robots.txt, per host");

const catalogue = async () => ["ceramic-mug", "steel-bottle"];
const storeMap = await sitemapFor(STORE, catalogue);
const corpMap = await sitemapFor(CORP, catalogue);
console.log("  xetastore.in/sitemap.xml:");
for (const u of storeMap) console.log(`    ${u}`);
console.log("  xeta.in/sitemap.xml:");
for (const u of corpMap) console.log(`    ${u}`);

check("the store's sitemap lists only its own clean URLs", () => {
  for (const u of storeMap) {
    const url = new URL(u);
    assert.equal(url.host, STORE);
    assert.ok(!url.pathname.startsWith("/shop"), u);
    // And each one really is a store page once the proxy sees it.
    assert.equal(decide(url.host, url.pathname).action, "rewrite", u);
  }
});
check("the corporate sitemap lists the same products under /shop, untouched by the proxy", () => {
  assert.ok(corpMap.includes("https://xeta.in/shop/ceramic-mug"));
  for (const u of corpMap) assert.notEqual(decide(CORP, new URL(u).pathname).action, "rewrite", u);
});
check("both files are themselves reachable on the store domain", () => {
  assert.equal(decide(STORE, "/sitemap.xml").action, "pass");
  assert.equal(decide(STORE, "/robots.txt").action, "pass");
});

const storeRobots = robotsFor(STORE);
console.log("  xetastore.in/robots.txt:");
for (const l of storeRobots.split("\n")) console.log(l ? `    ${l}` : "");
check("each robots.txt blocks the checkout path it actually serves, and names its own sitemap", () => {
  assert.match(storeRobots, /^Disallow: \/checkout$/m);
  assert.doesNotMatch(storeRobots, /\/shop\/checkout/);
  assert.match(storeRobots, /^Sitemap: https:\/\/xetastore\.in\/sitemap\.xml$/m);
  const corpRobots = robotsFor(CORP);
  assert.match(corpRobots, /^Disallow: \/shop\/checkout$/m);
  assert.match(corpRobots, /^Sitemap: https:\/\/xeta\.in\/sitemap\.xml$/m);
});

const broken = async () => {
  throw new Error("catalogue query failed (simulated)");
};
const storeMapBroken = await sitemapFor(STORE, broken);
const corpMapBroken = await sitemapFor(CORP, broken);
check("a failed catalogue query costs the product entries, not the whole file", () => {
  assert.deepEqual(storeMapBroken, ["https://xetastore.in/"]);
  assert.ok(corpMapBroken.includes("https://xeta.in/shop"));
  assert.ok(!corpMapBroken.some((u) => u.includes("ceramic-mug")));
});

// ---------------------------------------------------------------------------
section("7. Rewrite, not redirect: what the browser gets back");

// A stand-in for the platform: it applies decide() and reports which route
// rendered. With x-demo-mode: redirect it answers the way a redirect-based
// design would, so the two can be compared.
const server = http.createServer((req, res) => {
  const d = decide(req.headers.host, req.url);
  if (req.headers["x-demo-mode"] === "redirect" && d.action === "rewrite") {
    res.writeHead(308, { location: d.to });
    return res.end();
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`rendered ${d.to}`);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();

function get(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

try {
  const rw = await get("/cart", { host: STORE });
  const rd = await get("/cart", { host: STORE, "x-demo-mode": "redirect" });
  console.log(`  rewrite:  GET xetastore.in/cart -> ${rw.status}, body "${rw.body}", no Location`);
  console.log(`  redirect: GET xetastore.in/cart -> ${rd.status}, Location ${rd.location}`);
  check("a rewrite answers the clean URL directly, so the address bar keeps /cart", () => {
    assert.equal(rw.status, 200);
    assert.equal(rw.location, undefined);
    assert.equal(rw.body, "rendered /shop/cart");
  });
  check("a redirect would send the browser to /shop/cart, which is what the domain was meant to hide", () => {
    assert.equal(rd.status, 308);
    assert.equal(rd.location, "/shop/cart");
  });
  const corp = await get("/cart", { host: CORP });
  check("the same request on xeta.in is not rewritten", () => {
    assert.equal(corp.body, "rendered /cart");
  });
} finally {
  server.close();
}

console.log(`\n${passed} checks passed.`);
