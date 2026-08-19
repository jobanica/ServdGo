# Data Model (proposed)

A first-pass Supabase/Postgres schema. Field lists are indicative, not final —
lock the [open decisions](open-decisions.md) before writing migrations, since
several (delivery-fee model, customer accounts, payment routing) change columns.

## Entities overview

```
profiles ──< riders
             riders ──< rider_locations
             riders ──< commission_ledger ──> orders
             riders ──< settlements

stores ──< menu_categories ──< menu_items ──< menu_item_options

customers ──< orders ──< order_items ──> menu_items
                  orders ──> order_stores >── stores   (multi-store per order)
                  orders ──< order_status_events
                  orders ──> payments

app_settings   (singleton: operating hours, fees, commission rate, cutoff)
```

---

## Tables

### `profiles`
Base auth identity (Supabase Auth). Role: `customer` | `rider` | `admin`.

### `stores`
Admin-owned. No merchant login.
- `id`, `name`, `address`, `lat`, `lng`, `contact_number`
- `is_available` (bool) — **per-merchant on/off toggle**
- `category`, `created_at`

### `menu_categories`
- `id`, `store_id`, `title`, `sort_order`

### `menu_items`
- `id`, `store_id`, `category_id`, `name`, `price`, `is_available`, `description`

### `menu_item_options`
Per-item customization (options, variations, add-ons).
- `id`, `menu_item_id`, `group_name`, `option_name`, `price_delta`, `required` (bool)

### `customers`
- `id`, `profile_id`, `name`, `mobile_number` (**required**, used for calls + OTP)
- saved addresses (own table or JSON)

### `orders`
The unified queue. One row per order regardless of surface (web/mobile).
- `id`, `customer_id`, `rider_id` (nullable until accepted)
- `service_type` — `food` | `pabili` | `padala`
- `status` — `pending | accepted | preparing | picked_up | on_the_way | delivered | cancelled`
- `payment_method` — `cod` | `online` | `rider_qr`
- `payment_status` — `unpaid` | `paid`
- **Fees:** `delivery_fee`, `store_fee_total`, `convenience_fee`, `commission_amount`
- **Goods:** `goods_cost` (Food/Pabili; pass-through, excluded from commission)
- **Pabili:** `estimated_amount`, `budget_cap`, `actual_amount`
- **Padala:** `pickup_lat/lng`, `pickup_contact`, `dropoff_lat/lng`, `dropoff_contact`,
  `item_description`, `fee_payer` (`sender` | `receiver`)
- `delivery_lat/lng`, `customer_contact`, `customer_name`, `notes`, `created_at`
- `delivered_at` — stamped when the order reaches `delivered`; the business day
  the rider's earnings and commission are booked against
- `customer_name` is denormalized from `customers.name` on insert (riders can't
  read the customers table), so the pool shows who the order is for

### `order_items`
Food/Pabili line items.
- `id`, `order_id`, `menu_item_id` (nullable for Pabili free-text), `name`,
  `qty`, `unit_price`, `options` (JSON), `notes`

### `order_stores`
Which stores an order touches (drives ₱25/store math; max 3).
- `order_id`, `store_id`

### `order_status_events`
Audit trail of status transitions (for tracking + history).
- `id`, `order_id`, `status`, `at`, `by`

### `payments`
- `id`, `order_id`, `method`, `amount`, `provider_ref`, `status`, `at`

---

## Rider tables

### `riders`
- `id`, `profile_id`, `name`, `mobile_number`, `id_document`, `vehicle`
- `application_status` — `pending` | `approved` | `rejected`
- `is_locked` (bool) — set when previous-day balance unsettled
- `qr_code_ref`, `created_at`

### `rider_locations`
Live GPS during active delivery (or use Realtime broadcast without persisting).
- `rider_id`, `order_id`, `lat`, `lng`, `at`

### `commission_ledger`
Every completed order's commission.
- `id`, `rider_id`, `order_id`, `amount`, `settled` (bool), `business_day`, `at`

### `settlements`
- `id`, `rider_id`, `business_day`, `amount_due`, `method`, `reference`,
  `status` (`pending` | `confirmed`), `confirmed_by`, `at`

---

## Settings

### `app_settings` (singleton row)
- **Operating hours:** `is_open` (system-wide switch), `schedule` (JSON)
- **Fees:** `default_delivery_fee`, `per_store_fee` (25), `convenience_fee`,
  `commission_rate` (0.15)
- `delivery_fee_model` — `flat` | `per_km` | `per_zone`
- `settlement_cutoff_time`
- `convenience_fee_mode` — `pass_through` | `in_base`

---

## RLS sketch

- **Customers** read available stores/menus; read/write only their own orders.
- **Riders** read the open order pool (pending, unassigned) + their own accepted
  orders; write status/location/actual-amount on their orders; read own ledger.
  Blocked from accepting when `is_locked = true`.
- **Admin** full access to everything (service role or admin-claim policies).
- **`app_settings`** readable by all, writable by admin only.
