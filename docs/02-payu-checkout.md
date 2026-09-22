# Taking payments with PayU hosted checkout

Shipped in July 2026. The same PayU integration serves both subscription plans and store orders.

## What problem it solves

In a hosted checkout, card details are entered on PayU's page and never reach our server. Everything else passes through the buyer's browser: the cart, the amount going to PayU, and the result coming back. Anyone can edit that traffic or POST to a public URL. So how does PayU know the amount is ours, how do we know a "success" came from PayU, and what is an order while its payment is in flight?

## How it works

```
browser                      server                          PayU
   | cart: [{slug, qty}] ---> |                                |
   |                          | price from catalogue, check    |
   |                          | stock, save awaiting_payment   |
   | <--- form + forward hash |                                |
   | form -------------------------------------------------->  | check hash, take payment
   | <---------------------------------- result + reverse hash |
   | result ----------------> | verify, then confirm or cancel |
   | <-- 303 to result page   |                                |
```

1. The checkout sends slugs, quantities, delivery details and a payment method. The server looks each slug up in the active catalogue, drops unknown ones, clamps quantities and works out the total itself.
2. Short stock is reported now, before any money moves. Every order needs a signed-in buyer and complete delivery details. An online order is saved as awaiting payment; cash on delivery is placed immediately and never goes to PayU.
3. The server puts the order id in `txnid` and again in `udf1`, the total as a two-decimal string, and a fixed tag in `udf5` that marks a store payment rather than a subscription. It signs them with SHA-512 over PayU's documented forward sequence (the five empty slots are `udf6` to `udf10`):

   ```
   key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT
   ```

4. The browser turns the reply into a hidden form and submits it to PayU, which recomputes the hash with its copy of the salt and refuses the request if a signed field changed.
5. PayU has the browser POST the result to our callback. The server recomputes the reverse hash from the values in that POST and compares it in constant time. If PayU added charges, that value is prefixed as `additionalCharges|`:

   ```
   SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
   ```

6. A verified success confirms the order and records PayU's payment reference and the time paid. Only then is stock taken, the receipt and owner alert sent, and the order handed to the courier. A verified failure cancels the placeholder. An unverified response writes nothing, and the result page says nothing was marked paid. Every outcome is a 303, so the result page loads with a GET.

## Decisions that matter

**Prices come from the catalogue, never from the request.** Only slug and quantity are read from each cart line. A price or total in the request is not rejected, just never read, so no code path can trust it by accident.

**The field order is public; only the salt is secret.** The merchant key travels to the browser inside the form. Each sequence is built as an array and joined with `|`, so the blank `udf` slots stay visible and nobody counts pipes.

**The amount is a string, formatted once.** The hash covers the exact characters, and `1597` hashes differently from `1597.00`. The same string goes into the hash and the form.

**The callback URL proves nothing; the reverse hash does.** Success and failure URLs point at one route, which reads `status` from the signed body. Flipping a failure to success breaks verification. So does moving a genuine success onto another order, because `txnid` and `udf1` are signed too.

**The routing tag is signed.** Subscriptions and store orders share one callback, told apart by `udf5`. A shared callback has to branch on something; if it guesses wrong, a charged buyer sees a failure page. Branching on `udf5`, which is inside both hashes, means a response cannot be moved between branches.

**An online order is not an order until the money lands.** If an online order were saved as placed before the buyer reached PayU, a failed payment would still show as "Order placed" and the owner would already have been emailed. So the placeholder is marked as awaiting payment, the orders page lists only cash-on-delivery orders and online orders with a paid time, and the receipt and owner alert wait for a verified success.

**Check stock before payment, take it after.** Taking stock at checkout would let abandoned payments hold units. If stock runs out before a payment lands, the paid order is still confirmed and the owner's alert flags the shortfall: the money is already taken, so refusing then is the worse outcome.

**A failure only cancels an unpaid placeholder.** The cancel touches only orders still awaiting payment, so a signed failure arriving after a payment cannot undo it.

**Test mode unless told otherwise.** Only a test-mode setting of exactly `false` selects `secure.payu.in`; a missing or mistyped value stays on `test.payu.in`. If the key or salt is missing, the server refuses online payment and points the buyer to cash on delivery rather than sign with an empty salt.

## The demo

```
node demos/02-payu-checkout/demo.mjs
```

Node 20+, no dependencies, no network. `payu.mjs` holds both hashes and the endpoint switch, `store.mjs` is a simplified merchant, and `fake-payu.mjs` plays the gateway with the same fake key and salt.

Every step is asserted. Forged cart prices are ignored, and the fake gateway refuses an edited or merely reformatted amount. The callback rejects a lowered amount, a failure flipped to success, a guessed salt, and a genuine payment moved onto another order. A later signed failure cannot undo a payment, and when two buyers pay for the last unit, the second order is confirmed and flagged as oversold.

## Limits of the demo

- In memory only: no database, no HTTP, no real PayU. The fake gateway mimics only what this flow uses.
- Sign-in, delivery-detail checks, notifications, courier handover and the subscription branch are left out.
- Stock is a plain number in one process. A real store should lower it with one conditional database update, so two buyers racing for the last unit cannot both take it; the one who misses is reported short.
- Order ids, fees, quantity limits, products, callback paths and the `udf5` tag are demo values.
