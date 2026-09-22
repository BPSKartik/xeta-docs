# Handing orders to a courier (Shiprocket) without losing them

Shipped in July 2026.

## What problem it solves

The store ships through Shiprocket, a courier aggregator. Pushing each paid order there automatically, instead of retyping it, is easy to get almost right, and the failures are quiet:

- the store thinks the courier has an order it never accepted;
- a parcel moves while the store still says "order placed";
- the same movement arrives twice and the buyer is told twice;
- a shipment cancelled at the courier leaves its units counted as sold.

None of these raises an error on its own; each has to be designed out.

## How it works

```
 confirmed --> take stock --> push --> classify reply
                                          |
                  no order id: keep <-----+-----> order id: store ids
                  reason, retry later                  |
                                                       v
      webhook (on scans) --> apply update <-- sync (button, daily)
                                  |
                                  v
            diff, one conditional write; if it moved the status:
              cancelled -> return stock
              shipped / delivered -> tell the buyer
```

1. An order is confirmed on placement (cash on delivery) or when payment lands (online), takes its stock with a conditional decrement (`WHERE stock >= qty`) and goes to the courier.
2. The push fills in the fields the courier insists on, classifies the reply, and stores the courier's ids or the reason.
3. Label, invoice and pickup booking stay manual in the courier's panel, by design.
4. Parcel news arrives pushed (webhook) or pulled (sync), through one function. Translating the courier's status words is not covered here.

## The decisions that matter

**A 200 is not an order.** Shiprocket answers some invalid orders with HTTP 200 and an explanation in the body. A client that reads only the status code saves rejected orders as handed over with an empty courier id: shown as sent, with no retry offered, and never received. So success means a courier order id in the body. Anything else is a failure carrying the courier's own words.

**City and state come from the pincode.** Checkout collects one address line and a pincode, but the courier rejects an order without a city and state. So the pincode goes through the courier's own postcode lookup, so the answer agrees with what it validates against. A malformed pincode is never looked up, half an answer counts as none, and both fall back to optional configured defaults.

**The pickup location is a nickname the courier must already know.** It is the name of an address saved in the courier account, and an unknown name is a rejection, so a typo or an assumed "Primary" looked exactly like the API being down. The client reads the saved list and uses the configured name if present (ignoring case), else the primary address, else the first, logging when it overrides the setting.

**Failure is a value, and a retry never duplicates.** The push never throws: a courier outage must not cost an order the buyer has paid for. The reason is stored on the order and shown in the admin panel beside a retry button. Once an order has a courier order id, a retry is refused, so it cannot create a second shipment.

**Don't wait to be told.** The webhook fires only on real courier scans; a label or a booked pickup produces nothing, so the first hours after shipping are silent. And a webhook never saved in the courier's dashboard looks exactly like a parcel that hasn't moved. So tracking is also pulled: an admin "Sync tracking" button and a daily job ask about recent in-flight parcels and feed the answers through the webhook's update function.

**One update path, and the write decides who speaks.** The same movement often arrives twice, by webhook and by sync. The shared function:

- ignores orders never handed to the courier;
- diffs status, courier name and tracking number against the stored order, so known news changes nothing and sends nothing;
- writes with one conditional update (compare-and-set): the status must still be the one it read, and an order never moves out of delivered or cancelled, so a late "shipped" cannot reopen it and two copies of the same news cannot both win;
- returns stock or messages the buyer only when its own write changed the row, never merely on hearing the news. Messages go after the write, best-effort, on a transition into shipped or delivered.

**Stock follows a courier cancellation.** The courier can cancel a shipment too, and if that path puts nothing back the order reads as cancelled while its unit stays sold for good. So the return lives in the shared update path, tied to the transition into cancelled, so the units go back once however often it is reported.

## The demo

```
node demos/04-courier-integration/demo.mjs
```

Node 20+, no dependencies, no network, invented data. `courier.mjs` has the classifier, resolvers and a fake courier that rejects with 200s; `handover.mjs` the push; `store.mjs` an in-memory store, the update path and the sync. It asserts:

1. Seven sample replies classified correctly; a status-code-only check accepts four rejections.
2. A guessed pickup and a blank city each draw a 200 rejection; bad pincodes are never looked up.
3. An outage leaves the reason on the order; a retry succeeds; another is refused without calling the courier.
4. The sync finds a parcel the webhook never mentioned; the late webhook changes nothing.
5. Webhook and sync both read "new" before either writes, then apply "shipped": one message under compare-and-set, two under a weaker condition that only guards the final states. 200 shuffled runs give one message each.
6. Refused: news for an order never handed over, and "shipped" after "cancelled". A double cancellation returns stock once.

## Limits of this demo

- The store is a `Map`; a synchronous check-and-write stands in for one SQL `UPDATE ... WHERE`.
- Simplified: no authentication, token caching, HTTP or scheduler (the webhook is a function call; the tracker speaks the store's status words), a minimal payload, and messages as array entries.
- Every courier reply is invented, not captured from the real API.
