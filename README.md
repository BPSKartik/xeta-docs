# Xeta Engineering Notes

Short, practical write-ups of problems we solved while building Xeta — the
company behind Kevo and Vibzy, and its online shop — each paired with a small
demo you can run and read in a few minutes.

**These notes are for learning.** They explain real engineering decisions:
what went wrong the first time, what the fix was, and why. The demos are
simplified reimplementations of the ideas, written from scratch for teaching.
They are not the production code, they use obviously fake keys and data, and
they never talk to a real service.

## What's inside

| Topic | What it teaches | Demo |
| --- | --- | --- |
| [One login for several apps](docs/01-xeta-account-sso.md) | A small OAuth-style identity provider: short-lived single-use codes, exact redirect URIs, server-to-server token exchange | [demo](demos/01-xeta-account-sso) |
| [Hosted checkout with PayU](docs/02-payu-checkout.md) | SHA-512 request and response hashes, and why prices are always rebuilt on the server | [demo](demos/02-payu-checkout) |
| [Links that stand in for a login](docs/03-signed-links.md) | Deriving HMAC tokens instead of storing them, binding each token to one purpose, comparing in constant time | [demo](demos/03-signed-links) |
| [Handing orders to a courier](docs/04-courier-integration.md) | Why a `200 OK` is not proof of success, pulling status when webhooks stay quiet, sending each update exactly once | [demo](demos/04-courier-integration) |
| [A WhatsApp menu bot](docs/05-whatsapp-bot.md) | A per-number state machine, opt-out that every message respects, hand-over to a person, template-gated notifications | [demo](demos/05-whatsapp-bot) |
| [Verifying a phone number](docs/06-phone-verification.md) | One-time codes stored only as keyed hashes, attempt limits, rate limits per number | [demo](demos/06-phone-verification) |
| [A store on its own domain](docs/07-store-on-its-own-domain.md) | Serving one section of an app at the root of a second domain, and building links that work on both | [demo](demos/07-store-on-its-own-domain) |
| [Receipts and a product feed](docs/08-receipts-and-product-feed.md) | Not letting a document claim more than the business can back, printing dates in the buyer's time zone, a product feed ad platforms can read | [demo](demos/08-receipts-and-product-feed) |

Each note follows the same shape: the problem, how the solution works, the
decisions that mattered, what the demo shows, and where the demo stops short
of a real system.

## Running the demos

You need Node.js 20 or newer. There are no dependencies to install.

```bash
npm test
```

runs every demo and prints a pass/fail summary. To run one on its own:

```bash
node demos/03-signed-links/demo.mjs
```

Each demo prints a short walkthrough and checks its own claims with
`node:assert`, including the attacks it is supposed to refuse — a replayed
code, a tampered amount, a link used for the wrong purpose. If a check fails,
the demo exits with an error.

## A note on scope

The notes cover ideas, not a system to copy. Real deployments need things the
demos leave out on purpose — persistent storage, secret management,
monitoring, retries, and the provider's own current documentation, which
always wins over anything written here.
