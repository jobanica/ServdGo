-- ServdGo — the tracking link has to open a page, not its own source code.
--
-- Supabase serves HTML from an edge function as `content-type: text/plain` with
-- `x-content-type-options: nosniff`. That is deliberate on their side — it stops
-- anybody hosting arbitrary pages on a *.supabase.co domain — and it means the
-- diner clicking "Track rider" got a screenful of markup. JSON from the same
-- function is served correctly, so the data was never the problem; the hosting
-- was.
--
-- So the page moves to the customer web app, which is a real site on a domain we
-- own, and the function keeps doing what it does well: answering with JSON, and
-- redirecting a browser to the page.
--
-- Where that page lives is deployment configuration, not something to hardcode
-- in three places, so it sits on platform_settings with the rest of it.

alter table platform_settings
  add column if not exists customer_web_url text;

comment on column platform_settings.customer_web_url is
  'Public base URL of the customer web app. The tracking link a partner shows the diner is built from it.';

update platform_settings
   set customer_web_url = coalesce(customer_web_url, 'https://servdgo.vercel.app')
 where id;

/** The page a diner opens to watch their delivery. Null without a token. */
create or replace function tracking_link(p_token text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when nullif(btrim(coalesce(p_token, '')), '') is null then null
    else rtrim((select coalesce(customer_web_url, '') from platform_settings where id), '/')
         || '/track?t=' || p_token
  end;
$$;
revoke all on function tracking_link(text) from public;
grant execute on function tracking_link(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Partners get the whole URL, not a token to assemble one from.
--
-- Every integration was building the link itself, which means every integration
-- had to be told the shape of it — and would have to be told again the day it
-- changed. Handing over the finished link makes that our problem, which is
-- where it belongs.
-- ---------------------------------------------------------------------------
create or replace function merchant_order_view(p_order uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'orderId', o.id,
    'reference', o.merchant_reference,
    'status', o.status,
    'trackingToken', o.tracking_token,
    'trackingUrl', tracking_link(o.tracking_token),
    'currency', 'PHP',
    'deliveryFee', o.delivery_fee,
    'convenienceFee', o.convenience_fee,
    'total', round(o.delivery_fee + o.convenience_fee, 2),
    'payer', 'diner',
    'pickup', jsonb_build_object('address', o.pickup_address, 'lat', o.pickup_lat, 'lng', o.pickup_lng),
    'dropoff', jsonb_build_object('address', o.delivery_address, 'lat', o.delivery_lat, 'lng', o.delivery_lng),
    'recipient', jsonb_build_object('name', o.recipient_name, 'contact', o.recipient_contact),
    'rider', case when r.id is null then null else jsonb_build_object(
      'name', r.name, 'contact', r.mobile_number, 'vehicle', r.vehicle,
      'position', last_rider_position(o.id)) end,
    'placedAt', o.created_at,
    'arrivedAt', o.arrived_at,
    'deliveredAt', o.delivered_at
  )
  from orders o
  left join riders r on r.id = o.rider_id
  where o.id = p_order;
$$;
revoke all on function merchant_order_view(uuid) from public;
grant execute on function merchant_order_view(uuid) to service_role;
