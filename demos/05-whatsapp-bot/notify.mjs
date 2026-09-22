/**
 * Order updates the business starts.
 *
 * These go to someone who may not have written to us in a day, so each one
 * needs an approved template, and each one costs money to send. That is why
 * every kind of notice is gated on its own template name: no name, no request.
 *
 * All best-effort. An order must never fail, and a status update never stall,
 * because a message didn't go out, so `send` answers { sent: false, reason }
 * and never throws.
 */

import { digits } from "./bot.mjs";

/** Orders keep ten digits; WhatsApp wants the country code in front. */
const toWa = (phone) => {
  const d = digits(phone);
  return d.length === 10 ? `91${d}` : d;
};

const firstName = (n) => String(n || "there").trim().split(/\s+/)[0] || "there";

export function createNotifier({ templates, cloud, isOptedOut }) {
  async function send(kind, phone, params) {
    const name = templates[kind];
    // Unset means "not ready": send nothing and carry on. An unapproved name
    // gets further, is refused by the platform, and ends up in the same place.
    if (!name) return { sent: false, reason: `no template set for "${kind}"` };

    const to = toWa(phone);
    if (to.length < 11) return { sent: false, reason: "not a usable number" };

    // STOP is checked on every send we start, not once when it was typed.
    if (isOptedOut(to)) return { sent: false, reason: "this number replied STOP" };

    const r = await cloud.sendTemplate(to, name, params).catch((e) => ({ ok: false, error: e.message }));
    return r.ok ? { sent: true, template: name } : { sent: false, reason: r.error };
  }

  return {
    orderConfirmed: (o) => send("confirmed", o.phone, [firstName(o.name), o.id, String(o.total)]),
    orderShipped: (o) => send("shipped", o.phone, [firstName(o.name), o.id, o.courier || "Courier", o.tracking || "-"]),
    orderDelivered: (o) => send("delivered", o.phone, [firstName(o.name), o.id]),
  };
}
