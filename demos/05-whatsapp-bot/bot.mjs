/**
 * The menu bot as a pure state machine: one session per number, no network,
 * no database and no clock of its own. Every call is handed `now`, and the
 * caller delivers whatever replies come back. That is what lets the demo script
 * a whole conversation, a day-long handover included, in a few milliseconds.
 *
 * Simplified: a real bot stores sessions durably, and may have a submenu per
 * product and an assistant for support questions. None of that changes the routing.
 */

export const HANDOVER_MS = 24 * 60 * 60 * 1000;

// Typed words, not taps. Greetings count as "menu": they are what a first
// message usually is, and they should always get somewhere.
const MENU_WORDS = new Set(["menu", "hi", "hello", "hey", "help", "namaste"]);
const STOP_WORDS = new Set(["stop", "unsubscribe", "band karo"]);
const START_WORDS = new Set(["start", "resume"]);

// An order number works on its own or pasted into a sentence.
const ORDER_ID = /DEMO-[A-Z0-9]+/i;

export const digits = (p) => String(p ?? "").replace(/\D/g, "");
/** Numbers reach WhatsApp with the country code; orders keep the last ten. */
export const last10 = (p) => digits(p).slice(-10);

// WhatsApp rejects the whole message if one label is over length, so every
// field is clipped where the message is built rather than trusted to callers.
export const LIMITS = { rows: 10, title: 24, description: 72, button: 20, buttons: 3 };
const clip = (s, n) => String(s ?? "").slice(0, n);

export function listMessage({ body, button, rows }) {
  return {
    kind: "list",
    body,
    button: clip(button, LIMITS.button),
    rows: rows.slice(0, LIMITS.rows).map((r) => ({
      id: r.id,
      title: clip(r.title, LIMITS.title),
      ...(r.description ? { description: clip(r.description, LIMITS.description) } : {}),
    })),
  };
}
const text = (body) => ({ kind: "text", body });
const buttons = (body, btns) => ({
  kind: "buttons",
  body,
  buttons: btns.slice(0, LIMITS.buttons).map((b) => ({ id: b.id, title: clip(b.title, LIMITS.button) })),
});

const BACK = { id: "m:main", title: "Main menu" };

function mainMenu() {
  return listMessage({
    body: "Hi! Pick one below, or just type your question.",
    button: "Open menu",
    rows: [
      { id: "m:track", title: "Track my order", description: "Orders placed with this number" },
      { id: "m:shop", title: "The shop", description: "Browse, delivery, returns" },
      { id: "m:support", title: "Support", description: "Talk to us about anything" },
    ],
  });
}

const STATUS = { placed: "Order placed", shipped: "On its way", delivered: "Delivered", cancelled: "Cancelled" };

export function createBot({ orders }) {
  const sessions = new Map();

  // One session per number, made on first contact. Everything the bot knows
  // about a conversation lives here, so two people never share a state.
  function session(phone) {
    const key = digits(phone);
    if (!sessions.has(key)) {
      sessions.set(key, { state: "menu", handoverUntil: null, optedOut: false });
    }
    return sessions.get(key);
  }

  // Unpaid checkouts are not orders yet, so no lookup ever shows one.
  const placed = (o) => o.status !== "awaiting_payment";

  /**
   * Status for one order, keyed only by its id. Whoever sent the id is not
   * proven to own it (a tap's id can be forged as easily as text is typed), so
   * the reply says what a parcel tracking number would: status, courier,
   * items. Never the address or phone, even though the order carries both.
   */
  function orderStatus(raw) {
    const id = raw.toUpperCase();
    const o = orders.find((x) => x.id === id && placed(x));
    if (!o) return text(`I couldn't find a placed order with the number ${id}.`);
    const track = o.status === "shipped" && o.tracking ? `\n${o.courier} - tracking ${o.tracking}` : "";
    const items = o.items.map((l) => `- ${l.name} x${l.qty}`).join("\n");
    return text(`${id}\n${STATUS[o.status] ?? "Order placed"}${track}\n${items}`);
  }

  /**
   * This number's own orders, with nothing asked for: WhatsApp has already
   * proved the sender controls the number, so orders placed with it are theirs.
   */
  function myOrders(phone, s) {
    // Nine at most, so the list plus a back row stays inside WhatsApp's ten.
    const mine = orders.filter((o) => o.phone === last10(phone) && placed(o)).slice(0, LIMITS.rows - 1);
    if (mine.length === 0) {
      s.state = "track_wait";
      return text("I couldn't find any orders placed with this number. If you used another one, send the order number.");
    }
    s.state = "menu";
    return listMessage({
      body: `Found ${mine.length} order${mine.length === 1 ? "" : "s"} on this number. Tap one for details.`,
      button: "View orders",
      rows: [
        ...mine.map((o) => ({ id: `order:${o.id}`, title: o.id, description: `${STATUS[o.status]} - ${o.items[0].name}` })),
        BACK,
      ],
    });
  }

  /**
   * One inbound message. `id` is set when a row or button was tapped, `text`
   * when something was typed. Returns the replies to send; `silent` is true
   * when the bot deliberately said nothing because a person has the chat.
   */
  function handle(phone, { text: typedRaw = "", id } = {}, now) {
    const s = session(phone);
    const lower = typedRaw.trim().toLowerCase();
    const wantsMenu = MENU_WORDS.has(lower);
    const reply = (...replies) => ({ replies, silent: false });

    // Opting out has to work from anywhere, before any other handling,
    // including while a person has the chat. It stops what we start; their own
    // messages are still answered, which is what someone typing STOP means.
    if (STOP_WORDS.has(lower)) {
      s.optedOut = true;
      return reply(text("Done. We won't send you order updates on WhatsApp any more. Reply START to turn them back on."));
    }
    if (START_WORDS.has(lower)) {
      s.optedOut = false;
      return reply(text("You're back on for WhatsApp order updates."));
    }

    // A person is answering: say nothing, so the bot can't talk over them.
    // "menu" is checked first, so it is still a way out.
    if (s.handoverUntil !== null && s.handoverUntil > now && !wantsMenu) {
      return { replies: [], silent: true };
    }

    // Taps route on the id we set when building the menu, never on the label.
    const choice = id ?? "";
    if (choice.startsWith("order:")) return reply(orderStatus(choice.slice(6)));
    switch (choice) {
      case "m:main":
        s.state = "menu";
        return reply(mainMenu());
      case "m:track":
        return reply(myOrders(phone, s));
      case "m:shop":
        return reply(text("Everything we sell is on the website; cash on delivery and UPI both work."));
      case "m:support":
        s.state = "support";
        return reply(buttons("Ask here, or tap below and a person will reply.", [{ id: "sup:human", title: "Talk to a person" }, BACK]));
      case "sup:human":
        s.state = "human";
        s.handoverUntil = now + HANDOVER_MS;
        return reply(text("Done. A person will reply here. Type menu to go back to the automated menu."));
    }

    // Typed, not tapped.
    if (wantsMenu) {
      // Typing "menu" ends a handover, so the menu it brings back is live.
      s.handoverUntil = null;
      s.state = "menu";
      return reply(mainMenu());
    }

    const m = ORDER_ID.exec(typedRaw);
    if (m) return reply(orderStatus(m[0]));

    if (s.state === "track_wait") {
      return reply(text("That doesn't look like an order number. They look like DEMO-A1. Type menu to go back."));
    }
    if (s.state === "support") {
      // A support assistant could answer here; the demo only offers the person.
      return reply(buttons("Thanks. Tap below and a person will pick this up.", [{ id: "sup:human", title: "Talk to a person" }, BACK]));
    }

    // Anything else, first "hi" or a stray message, gets the menu, not a shrug.
    s.state = "menu";
    return reply(mainMenu());
  }

  return {
    handle,
    /** Read by the notifier: someone who replied STOP hears nothing we start. */
    isOptedOut: (phone) => sessions.get(digits(phone))?.optedOut === true,
    peek: (phone) => ({ ...session(phone) }),
  };
}
