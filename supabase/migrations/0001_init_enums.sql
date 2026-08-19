-- Easy Buy Delivery — enums and shared types
-- Service types, order lifecycle, payment, rider and settlement states.

create type service_type as enum ('food', 'pabili', 'padala');

create type order_status as enum (
  'pending',      -- created, waiting for a rider
  'accepted',     -- a rider accepted
  'preparing',    -- store prepping (food/pabili)
  'picked_up',    -- goods/item collected
  'on_the_way',   -- en route to customer/dropoff
  'delivered',    -- completed
  'cancelled'
);

create type payment_method as enum ('cod', 'online', 'rider_qr');
create type payment_status as enum ('unpaid', 'paid');

-- Who pays the delivery fee on a Padala order.
create type fee_payer as enum ('sender', 'receiver');

create type rider_application_status as enum ('pending', 'approved', 'rejected');

create type settlement_status as enum ('pending', 'confirmed');

-- Convenience fee handling: flat pass-through to admin, or folded into the 15% base.
create type convenience_fee_mode as enum ('pass_through', 'in_base');

-- Delivery fee pricing model (open decision #3).
create type delivery_fee_model as enum ('flat', 'per_km', 'per_zone');

create type user_role as enum ('customer', 'rider', 'admin');
