# A WhatsApp menu bot for the whole company (Cloud API)

Shipped in July 2026. It started by answering order numbers and sending a shipped notice, then grew a menu covering every product, the other order notices, STOP/START, and a confirmation that carries the receipt.

## What problem it solves

One WhatsApp number answers for several products: a store and two apps. The first version understood only order numbers, so "hi", a question about one of the apps or a typo got a fixed line. The bot needed to answer anything with something tappable, remember each conversation, go quiet when a person took over, and respect STOP.

## How it works

The handler receives the sender's number, any typed text, and the id of a tapped row or button. A tap carries the id we set when building the menu (`m:track`, `sup:human`, `order:<id>`), so a choice is never guessed from a label's wording.

```
inbound: number, text, tapped id
   |
   load (or create) this number's session
   |
   +-- STOP / START? ---------------------> set or clear opt-out, confirm
   +-- a person has the chat,
   |   and the text is not "menu"? -------> say nothing
   +-- tapped id? ------------------------> menu, submenu, order list, handover
   +-- "menu" or a greeting? -------------> main menu
   +-- an order number in the text? ------> that order's status
   +-- state waiting on something? -------> the answer for that state
   +-- anything else ---------------------> main menu
```

Each number has one saved conversation state: where it is in the menu, a small context such as the support topic, when a handover ends, and whether the number opted out.

All of these are replies inside the 24-hour window the customer's message opens, where text, lists and buttons need no approved template.

## The decisions that matter

**The fallback is the menu, not an apology.** A greeting, a question and nonsense all get the tappable main menu. With three products behind one number, the useful first reply asks which one.

**Route on ids, and clip every label.** If one label is too long (24 characters for a row title, at most 10 rows), WhatsApp rejects the whole message. Labels are clipped where the message is built. "My orders" shows nine orders at most, which leaves room for the back row.

**"Menu" is checked before the handover silence.** From any state, typing "menu" or a greeting brings back the main menu.

**A handover silences the bot for 24 hours.** "Talk to a person" sets an end time a day ahead. Until then the bot sends nothing to that number, so it can't talk over whoever is answering.

**STOP is checked first and means "stop starting conversations".** The stop words, one of them Hinglish, work even mid-handover. The flag blocks the order notices the business starts. Their own messages are still answered, which is what someone typing STOP means. START clears the flag.

**Messages the business starts need approved templates, and each one is gated.** Outside the window WhatsApp accepts only approved templates, and each send costs money. Each order notice (confirmed, shipped, delivered) reads its own template name from configuration. If the name is unset, no request is made and the notice returns "not sent". If it is unapproved, Meta refuses, the refusal is logged, and the notice still returns "not sent" instead of throwing. An opted-out number, a malformed number and a network error end the same way; opt-out is checked on every send. An order must never fail, and a status update must never stall, because a message didn't go out.

**A new shape means a new template.** An approved template fixes its number of body variables and whether it has a document header, and a send that doesn't match is refused. So the confirmation that carries the receipt is its own approved template, not an edit to the live one. Left unset, the original goes out unchanged. Templates are declared in code and created through the API from there; retyping them into Meta's dashboard lets a body drift from its example values, the usual cause of rejection.

**Looking up orders by the sender's number needs no OTP.** WhatsApp has already proved that the sender controls the number. So "Track my order" lists that number's orders, matched on the last ten digits and excluding unpaid checkouts, without asking for anything. The other direction, a number typed into the website, does need a code, sent through a template.

**An order id is treated like a tracking number.** Anyone can type an order id or forge a tap that carries one. So a reply keyed only by an id gives status, courier, tracking and items, and never the address, phone or email. Rows in "my orders" get the same reply.

**The bot has its own number.** A number registered on the Cloud API can no longer be used in the WhatsApp app, so it can't be anyone's everyday phone. The bot gets a number of its own.

## The demo

```
node demos/05-whatsapp-bot/demo.mjs
```

`bot.mjs` is the router as a pure state machine: sessions in a `Map`, the clock passed in, replies returned rather than sent. `notify.mjs` is the template gate. `fake-cloud.mjs` stands in for the send endpoint and enforces only the 24-hour window and template approval, including the variable count.

The scripted conversation goes: "hi", a stray question, "Track my order", one order, "Talk to a person", a message the bot ignores, STOP mid-handover, a shipped notice suppressed before any request, START, the notice sent, and "menu" ending the handover. A second number shows that state is per number. The gate is then tried unset, unapproved, with the wrong variable count and with the API unreachable. Each returns "not sent", and none throws.

Attacks and failures the demo asserts are rejected:

- A stranger asking for someone else's order, by typed id or forged tap, gets the status but never the address or phone.
- An unpaid checkout's id comes back "not found".
- Free-form text sent three days later is refused.
- A handover nobody ends expires after a day.

## Limits of this demo

- Sessions live in memory and vanish on restart. A real bot stores them durably and falls back to the menu state if a read fails.
- No HTTP or webhook layer, no per-product submenus, support topic picker or support assistant; order statuses are simplified.
- START only confirms; it does not send the main menu again.
