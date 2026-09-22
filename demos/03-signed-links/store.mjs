// A toy store with two routes, just enough to show where the check sits.
// Simplified: a node:http server on 127.0.0.1, a Map instead of a database,
// and plain text instead of a PDF or a review form.

import { createServer } from "node:http";
import { ROUTE_FOR } from "./signer.mjs";

// Each route owns its purpose. The URL supplies an order id and a token, never
// the purpose, so nobody can ask for a receipt token to be judged as a review.
const PURPOSE_OF = Object.fromEntries(Object.entries(ROUTE_FOR).map(([p, r]) => [r, p]));

export async function startStore(signer, orders) {
  const stats = { orderReads: 0 };

  const server = createServer((req, res) => {
    const reply = (status, body) => {
      // What a link opens is private to one order: never cached publicly.
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" });
      res.end(body);
    };
    // One plain answer for every failure: the caller learns only that this
    // link does not open anything, never which check it failed.
    const notFound = () => reply(404, "Not found");

    const [, route, rawId, token, ...rest] = new URL(req.url, "http://store.local").pathname.split("/");
    const purpose = PURPOSE_OF[route];
    if (req.method !== "GET" || !purpose || !rawId || !token || rest.length) return notFound();

    let orderId;
    try {
      orderId = decodeURIComponent(rawId);
    } catch {
      return notFound(); // a broken %-escape is just another bad link
    }

    // Verify before touching the data: a forged link costs no read at all.
    if (!signer.verify(purpose, orderId, token)) return notFound();

    stats.orderReads++;
    const order = orders.get(orderId);
    // A valid token does not outlive its order.
    if (!order) return notFound();

    reply(
      200,
      purpose === "review"
        ? `Review form for ${orderId}: ${order.items.join(", ")}`
        : `Receipt for ${orderId}: total ${order.total}`,
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    stats,
    // Open a public link against this local server: same path, local origin.
    open: async (link) => {
      const res = await fetch(origin + new URL(link).pathname);
      return { status: res.status, body: await res.text() };
    },
    openPath: async (path) => {
      const res = await fetch(origin + path);
      return { status: res.status, body: await res.text() };
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
