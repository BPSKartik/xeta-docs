// A pretend internet, so the demo needs no ports and no network.
//
// Each site is a handler(req) -> res, keyed by its origin. The Browser keeps
// cookies per origin and follows redirects the way a real one does.
// backChannel() is one server calling another: it never goes through the
// browser, so it carries none of the browser's cookies and the browser never
// sees what it sends.

export const json = (status, data, cookies) => ({ status, data, cookies });
export const redirect = (location, cookies) => ({ status: 302, location: String(location), cookies });

export function createWeb() {
  const sites = new Map();
  const log = []; // every request, in order: { via, method, href }

  async function dispatch(via, method, href, { cookies = {}, body } = {}) {
    const url = new URL(href);
    const site = sites.get(url.origin);
    if (!site) throw new Error(`nothing is listening at ${url.origin}`);
    log.push({ via, method, href: url.href });
    // Serialise the body as a real request would, so no site ever holds a
    // reference into another site's objects.
    const parsed = body === undefined ? undefined : JSON.parse(JSON.stringify(body));
    return site({ method, url, cookies, body: parsed });
  }

  return {
    log,
    host: (origin, handler) => void sites.set(origin, handler),
    fromBrowser: (method, href, opts) => dispatch("browser", method, href, opts),
    backChannel: (href, body) => dispatch("server", "POST", href, { body }),
  };
}

export class Browser {
  #jars = new Map(); // origin -> Map(cookie name -> value)

  constructor(web) {
    this.web = web;
  }

  jar(origin) {
    if (!this.#jars.has(origin)) this.#jars.set(origin, new Map());
    return this.#jars.get(origin);
  }

  // Like opening a URL (or submitting a form, with method POST): a redirect
  // becomes a GET of its `location`, sent with that origin's cookies.
  // follow:false stops at the first response, which is how the demo catches a
  // code in flight.
  async go(href, { method = "GET", body, follow = true } = {}) {
    for (let hop = 0; hop < 10; hop++) {
      const url = new URL(href);
      const jar = this.jar(url.origin);
      const res = await this.web.fromBrowser(method, url.href, { cookies: Object.fromEntries(jar), body });
      for (const [name, value] of Object.entries(res.cookies ?? {})) {
        if (value === null) jar.delete(name);
        else jar.set(name, value);
      }
      res.url = url.href;
      if (!res.location || !follow) return res;
      href = new URL(res.location, url.origin).href;
      method = "GET";
      body = undefined;
    }
    throw new Error("too many redirects");
  }
}
