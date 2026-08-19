# Service Flows

Three service types run on the same rider network. All create rows in the same
order queue.

---

## Food

Order from stores/menus the admin has added.

1. Customer browses stores + menus, builds a cart, checks out.
2. Order created → **Rider App notified** (available riders see it).
3. A rider **accepts**.
4. Rider **calls the store** to have the food prepared for pickup.
5. Rider **picks up** and **pays the store with his own money** (fronts cash).
6. Rider **delivers**.
7. Customer **pays on delivery**: **cost of food + delivery fee** (cash), or online.
8. Rider recovers fronted cash + earns from delivery; **admin takes commission**.

**Cart supports multiple stores in one order** — this drives the ₱25/store logic
(up to 3 stores per trip).

---

## Pabili (buy-anything)

Same rails as Food, but there's no fixed menu — the customer requests **any item**
to be bought on their behalf (groceries, medicine, flowers, hardware, anything).

1. Customer creates a **Pabili request**: what to buy, where (or "any nearest
   store"), quantity, notes, and an **estimated budget / spending cap**.
2. Rider accepts → buys items with his own money → delivers.
3. Customer pays: **actual cost of goods (per receipt) + delivery fee**.

### Build for the unknowns

- Cost isn't known upfront, so the request needs an **estimated amount + a cap**
  the rider shouldn't exceed without confirming.
- Rider can **update the actual amount** after buying (ideally snap/enter the
  receipt total) so the final collectible is accurate.
- Consider a small **buffer/handling** rule so riders aren't out of pocket when
  actual > estimate. See open decision #5.

---

## Padala (send-package)

Point-to-point courier. **No goods are purchased** — the rider picks up an item
from one location and delivers it to another.

1. Customer creates a **Padala request**: pickup location + contact, drop-off
   location + contact, item description, notes (size/weight/fragile).
2. Rider accepts → goes to pickup → collects the item → delivers to drop-off.
3. Payment: **delivery fee only**.

### Notes

- Needs **two locations** (pickup + dropoff), unlike Food/Pabili which have one
  store-side and one customer-side.
- **Who pays the delivery fee** — sender or receiver? Selectable at request time.
- **No rider cash float** (nothing fronted) → lowest-risk service to launch first.
- Commission is straightforward: **15% of the delivery fee** (no store fee applies).

---

## Order status timeline (shared)

`accepted → preparing → picked up → on the way → delivered`

- Customer sees status + **live rider location on a map** once the rider is on
  the way, plus ETA.
- Rider updates status through the flow; GPS sharing auto-starts on pickup, stops
  on delivery.
