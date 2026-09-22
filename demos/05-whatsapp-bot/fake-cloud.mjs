/**
 * A stand-in for the Cloud API's send endpoint. It keeps only the platform
 * rules the design is built around, and nothing else of Meta's behaviour:
 *
 *   1. Free-form messages (text, lists, buttons) are accepted only inside the
 *      24 hours after the customer last wrote to us.
 *   2. A template is accepted only by a name that has been approved, and only
 *      with the number of body variables it was approved with.
 *
 * It never throws on a refusal; it answers { ok: false, error }, which is what
 * the real endpoint's error body amounts to. `setDown(true)` makes it throw, to
 * stand in for the network.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** `approved`: name -> how many body variables the approved template takes. */
export function createFakeCloud({ approved }) {
  const lastInbound = new Map();
  const log = [];
  let down = false;

  const ensureUp = () => {
    if (down) throw new Error("network unreachable");
  };
  const refuse = (entry, error) => {
    log.push({ ...entry, ok: false });
    return { ok: false, error };
  };

  return {
    /** Every inbound message reopens the customer's 24-hour window. */
    inbound(from, at) {
      lastInbound.set(from, at);
    },

    async sendFree(to, message, at) {
      ensureUp();
      const since = lastInbound.get(to);
      if (since === undefined || at - since > WINDOW_MS) {
        return refuse({ to, type: "free" }, "outside the 24-hour window; use a template");
      }
      log.push({ to, type: "free", ok: true, message });
      return { ok: true };
    },

    async sendTemplate(to, name, params) {
      ensureUp();
      const entry = { to, type: "template", name };
      const vars = approved.get(name);
      if (vars === undefined) return refuse(entry, `template "${name}" is not approved`);
      if (vars !== params.length) {
        return refuse(entry, `template "${name}" takes ${vars} variables, got ${params.length}`);
      }
      log.push({ ...entry, ok: true, params });
      return { ok: true };
    },

    setDown(v) {
      down = v;
    },
    /** How many template requests have reached the "API" at all. */
    templateRequests: () => log.filter((l) => l.type === "template").length,
    log,
  };
}
