# The ServdGo merchant API

For a partner platform — Servd — to book a rider without anybody holding a
phone, and to be told what happened afterwards.

Everything below is live in this repository. What is not built is the Servd side:
this is the spec to wire it against.

## Shape of it

```
Servd ──quote──▶ ServdGo        "what would this cost, and can anyone take it?"
Servd ──book───▶ ServdGo        a rider job is created and routed
ServdGo ──webhook──▶ Servd      every status change, with the rider's name and number
diner  ──tracking link──▶       one URL, no login
```

The rider collects the delivery fee from the diner at the door. The food is
already paid for on Servd's side, so a ServdGo merchant job is a courier run:
nothing is fronted, and commission, settlement and the franchise royalty all
work exactly as they do for an order placed in the app.

## Base URL and authentication

```
https://<project-ref>.supabase.co/functions/v1/
```

Every call carries the restaurant's own key:

```
X-API-Key: sgo_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

`Authorization: Bearer sgo_…` works too. Keys are per restaurant, not one shared
key, so a leak is revocable without taking every other restaurant offline.
ServdGo stores only a hash — the key is shown once, when the operator mints it.

A bad, revoked or deactivated key is always the same answer:

```json
401  { "error": "unauthorized", "message": "Unknown or revoked API key." }
```

## POST /merchant-quote

```json
{ "dropoff": { "lat": 10.3200, "lng": 123.8880 } }
```

```json
{
  "serviceable": true,
  "reason": null,
  "territory": "…", "territoryName": "Cebu",
  "currency": "PHP",
  "distanceKm": 1.31,
  "deliveryFee": 50.00,
  "convenienceFee": 5.00,
  "total": 55.00,
  "payer": "diner",
  "availability": { "ridersOnline": 3, "accepting": true }
}
```

`serviceable: false` comes back with a `reason` written for a human — the
drop-off is outside the area, the city is closed, courier jobs are switched off.
Show it; it is the operator's own wording.

**`availability` is the answer to "what does a restaurant see when no rider is
available".** ServdGo does not refuse the booking — an order with no rider sits
in the pool and is picked up when somebody comes online, which is what happens
to app orders too. What Servd does with `ridersOnline: 0` is Servd's call: warn,
delay, or book anyway. That decision is still open and is deliberately left in
your hands rather than baked in here.

## POST /merchant-book

```json
{
  "reference": "SERVD-1001",
  "dropoff": { "lat": 10.3200, "lng": 123.8880, "address": "9 Mango Ave, Cebu City" },
  "recipient": { "name": "Maria Santos", "contact": "09175556666" },
  "items": "Chicken adobo",
  "notes": "Ring the bell"
}
```

`reference` is Servd's own order id and is what makes this **safe to retry**:
booking the same reference twice returns the first order with
`"duplicate": true` rather than putting a second rider on the road. Retry freely
on a timeout.

```json
201  {
  "orderId": "…", "reference": "SERVD-1001", "status": "pending",
  "trackingToken": "…", "duplicate": false,
  "currency": "PHP", "deliveryFee": 50.00, "convenienceFee": 5.00, "total": 55.00,
  "payer": "diner",
  "pickup":  { "address": "123 Colon St", "lat": 10.3157, "lng": 123.8854 },
  "dropoff": { "address": "9 Mango Ave",  "lat": 10.3200, "lng": 123.8880 },
  "recipient": { "name": "Maria Santos", "contact": "09175556666" },
  "rider": null,
  "placedAt": "…", "arrivedAt": null, "deliveredAt": null
}
```

The fee is recomputed at booking rather than taken from the quote — a quote is a
quote, not an instruction. It will match unless the operator changed their fees
in between.

Required: `reference`, `dropoff.lat`, `dropoff.lng`, `dropoff.address`,
`recipient.contact`. The address matters as much as the pin: the pin gets the
rider to the street, the address gets them to the door.

## GET /merchant-order?reference=SERVD-1001

The same body, for polling or for reconciling after an outage.

## Errors

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | A required field is missing or the body is not JSON |
| 401 | `unauthorized` | Unknown, revoked, or belonging to a deactivated restaurant |
| 404 | `not_found` | No order with that reference for this restaurant |
| 422 | `unprocessable` | We will not do it: out of area, city closed, missing contact |
| 500 | `server_error` | Ours. Retry with backoff |

`message` on a 422 is written for a person and can be shown to the restaurant.

## Webhooks

### Who provides what

Setting a restaurant up, the two callback fields come from opposite directions
and this trips people up:

| | who provides it | if it is missing |
|---|---|---|
| **Webhook URL** | **the restaurant** — an endpoint on their own system | leave it blank; they poll `/merchant-order` instead, which is a perfectly good way to run |
| **Signing secret** | **us** — press *Generate* in the console | callbacks go out unsigned, and they have no way to tell a real one from anything else that finds the URL |

Send them three things together: their API key (shown once, at creation), the
signing secret, and the verification snippet below. The console's *Partner
restaurants → Where callbacks go* panel has all of it on screen.


Every status change is posted to the URL the operator holds for the restaurant.
The body is the same object `/merchant-order` returns, plus `event`:

```json
{ "event": "order.accepted", "orderId": "…", "reference": "SERVD-1001",
  "status": "accepted", "rider": { "name": "Ben Cruz", "contact": "09170000003",
  "vehicle": "Motorcycle" }, … }
```

Events: `order.created`, `order.accepted`, `order.preparing`, `order.picked_up`,
`order.on_the_way`, `order.delivered`, `order.cancelled`,
`order.rider_assigned`.

Headers:

```
X-ServdGo-Delivery: <uuid>          the delivery id; the same id on every retry
X-ServdGo-Signature: t=1712345678,v1=<hex hmac-sha256>
```

The signature is HMAC-SHA256 over `` `${t}.${rawBody}` `` with the shared secret.
**Verify it, and reject a `t` more than five minutes old** — that is what stops a
captured callback being replayed at you later:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(
    header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return v1.length === expected.length
    && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

Reply **2xx** to accept. Anything else — or a timeout past 10 seconds — is
retried with exponential backoff (1, 2, 4 … minutes) up to
`platform_settings.webhook_max_attempts`, default 8, which is about four hours of
trying. After that the delivery is marked `failed` and stays on the table as the
record that Servd was never told.

Deliveries are queued in an outbox and drained by a worker, so a restaurant that
is down for ten minutes gets its callbacks when it comes back, and no order is
ever held up by somebody else's outage. Retries carry the same
`X-ServdGo-Delivery`; **treat it as an idempotency key.**

Leave the webhook URL blank and nothing is queued — poll `/merchant-order`
instead.

## The tracking link

```
https://<project-ref>.supabase.co/functions/v1/track?t=<trackingToken>
```

One URL to hand the diner. No login. Returns a page a phone can open, or the
JSON behind it with `Accept: application/json`. It answers where the food is and
nothing else — no internal ids, no merchant reference, none of the restaurant's
contact details.

The token is 244 bits of randomness and is the only credential, so treat it like
one: it belongs in the message to that diner, not in a log or a shared channel.

## Routing

A restaurant's pickup pin decides which city's riders see the job — the same
rule an order placed in the app follows. A restaurant pinned outside every
territory cannot be issued a key, and a drop-off outside its city's radius is
refused at the quote, before a booking is attempted.

## Still open

- **Who pays.** Today the diner pays the rider at the door, which is why this
  needed no new money flow. Billing the restaurant instead inverts who owes
  whom — the operator would collect from Servd and owe the rider their
  earnings — and needs an invoicing and payout system that does not exist.
  Decide before signing a partner who expects to be invoiced.
- **What Servd shows when `ridersOnline` is 0.** See `/merchant-quote` above.

## Deploying it

```bash
supabase functions deploy merchant-quote  --no-verify-jwt
supabase functions deploy merchant-book   --no-verify-jwt
supabase functions deploy merchant-order  --no-verify-jwt
supabase functions deploy track           --no-verify-jwt
supabase functions deploy merchant-webhooks
```

`--no-verify-jwt` because callers authenticate with their own API key rather
than a Supabase user token. `merchant-webhooks` keeps JWT verification on — it
is called on the service role, by a schedule:

```sql
-- Supabase → Integrations → Cron, every minute
select net.http_post(
  url := 'https://<ref>.supabase.co/functions/v1/merchant-webhooks',
  headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>'));
```
