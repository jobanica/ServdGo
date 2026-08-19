-- ServdGo — "today" means today in the city, not today in UTC.
--
-- Found by the test suite failing at 22:12 UTC, which is 06:12 the next morning
-- in Manila. Everything the business records is dated by the city's clock —
-- `business_day` on the commission ledger is a Manila date, set by
-- record_commission_on_delivery. But `current_date` in Postgres is a UTC date,
-- and the two disagree from 16:00 UTC until midnight, which is midnight to
-- 08:00 in Manila. Every single day.
--
-- So a franchisor asking for "the last 30 days up to today" got a window ending
-- yesterday, and the morning's revenue was invisible until eight o'clock. Not a
-- rounding error — a whole shift of trading missing from the number the
-- franchise is run on.
--
-- The fix is one function and no more `current_date` anywhere a date is being
-- compared against something the business dated.

/**
 * Today, in a city's own timezone — or the platform's, when no city is named.
 *
 * Security definer because RLS on territories would otherwise hide the timezone
 * from a caller who can legitimately see the row this is dating.
 */
create or replace function business_today(p_territory uuid default null)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select (now() at time zone coalesce(
    (select t.timezone from territories t where t.id = p_territory),
    'Asia/Manila'))::date;
$$;
revoke all on function business_today(uuid) from public;
grant execute on function business_today(uuid) to anon, authenticated, service_role;

comment on function business_today(uuid) is
  'Today in the city''s timezone. Postgres current_date is UTC, which is yesterday for eight hours a day.';

-- ---------------------------------------------------------------------------
-- Paperwork expires on the day it says, in the city that holds it.
-- ---------------------------------------------------------------------------
create or replace view territory_document_expiry with (security_invoker = true) as
select d.id, d.territory_id, t.name as territory_name, d.kind, d.label, d.expires_at,
       (d.expires_at - business_today(d.territory_id)) as days_left,
       case when d.expires_at < business_today(d.territory_id) then 'expired'
            when d.expires_at <= business_today(d.territory_id) + 30 then 'expiring'
            else 'ok' end as state
  from territory_documents d
  join territories t on t.id = d.territory_id
 where d.expires_at is not null;

grant select on territory_document_expiry to authenticated;

-- ---------------------------------------------------------------------------
-- A bill is late by the operator's calendar, not by Greenwich's.
-- ---------------------------------------------------------------------------
create or replace view invoice_aging with (security_invoker = true) as
select s.id, s.territory_id, t.name as territory_name,
       s.period_start, s.period_end, s.due_at,
       s.amount_due, s.franchise_fee, s.royalty_amount, s.status,
       greatest(0, business_today(s.territory_id) - s.due_at) as days_overdue,
       case
         when s.status = 'confirmed' then 'paid'
         when s.due_at is null or business_today(s.territory_id) <= s.due_at then 'current'
         when business_today(s.territory_id) - s.due_at <= 15 then '1-15'
         when business_today(s.territory_id) - s.due_at <= 30 then '16-30'
         else '30+'
       end as bucket
  from operator_settlements s
  join territories t on t.id = s.territory_id;

grant select on invoice_aging to authenticated;

create or replace function territory_overdue_invoices(p_territory uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(amount_due), 0)::numeric(12, 2)
    from operator_settlements
   where territory_id = p_territory
     and status = 'pending'
     and due_at is not null
     and due_at < business_today(p_territory);
$$;
revoke all on function territory_overdue_invoices(uuid) from public;
grant execute on function territory_overdue_invoices(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- An export of "the last month" ends today, where the person asking lives.
-- ---------------------------------------------------------------------------
create or replace function hq_export(
  p_dataset   text,
  p_territory uuid,
  p_from      date default null,
  p_to        date default null
)
returns setof text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz    text;
  v_today date;
  v_from  date;
  v_to    date;
begin
  if p_territory is null then
    raise exception 'Export one city at a time' using errcode = 'check_violation';
  end if;
  if not staff_sees(p_territory) then
    raise exception 'not authorised' using errcode = 'insufficient_privilege';
  end if;

  select coalesce(timezone, 'Asia/Manila') into v_tz from territories where id = p_territory;
  if v_tz is null then
    raise exception 'No such territory' using errcode = 'no_data_found';
  end if;

  v_today := business_today(p_territory);
  v_from  := coalesce(p_from, v_today - 30);
  v_to    := coalesce(p_to, v_today);

  if v_to < v_from then
    raise exception 'The end of the period is before its start' using errcode = 'check_violation';
  end if;

  if p_dataset = 'deliveries' then
    return next csv_line(array['order_id','placed_at','delivered_at','status','service',
                               'rider','customer','contact','address','delivery_fee',
                               'store_fees','convenience_fee','goods','commission','payment']);
    return query
      select csv_line(array[
        o.id::text,
        to_char(o.created_at at time zone v_tz, 'YYYY-MM-DD HH24:MI'),
        to_char(o.delivered_at at time zone v_tz, 'YYYY-MM-DD HH24:MI'),
        o.status::text, o.service_type::text,
        r.name, o.customer_name, o.customer_contact, o.delivery_address,
        o.delivery_fee::text, o.store_fee_total::text, o.convenience_fee::text,
        o.goods_cost::text, o.commission_amount::text, o.payment_method::text])
        from orders o
        left join riders r on r.id = o.rider_id
       where o.territory_id = p_territory
         and (o.created_at at time zone v_tz)::date between v_from and v_to
       order by o.created_at;

  elsif p_dataset = 'commissions' then
    return next csv_line(array['ledger_id','business_day','rider','order_id','kind',
                               'amount','settled']);
    return query
      select csv_line(array[
        c.id::text, c.business_day::text, r.name, c.order_id::text, c.kind,
        c.amount::text, c.settled::text])
        from commission_ledger c
        join orders o on o.id = c.order_id
        left join riders r on r.id = c.rider_id
       where o.territory_id = p_territory
         and c.business_day between v_from and v_to
       order by c.business_day, r.name;

  elsif p_dataset = 'remittances' then
    return next csv_line(array['settlement_id','business_day','rider','amount_due',
                               'method','reference','status','confirmed_at']);
    return query
      select csv_line(array[
        s.id::text, s.business_day::text, r.name, s.amount_due::text,
        s.method, s.reference, s.status::text,
        to_char(s.confirmed_at at time zone v_tz, 'YYYY-MM-DD HH24:MI')])
        from settlements s
        join riders r on r.id = s.rider_id
       where r.territory_id = p_territory
         and s.business_day between v_from and v_to
       order by s.business_day, r.name;

  elsif p_dataset = 'royalty' then
    return next csv_line(array['entry_id','business_day','kind','base_amount','rate',
                               'amount','order_id','note']);
    return query
      select csv_line(array[
        y.id::text, y.business_day::text, y.kind, y.base_amount::text, y.rate::text,
        y.amount::text, y.order_id::text, y.note])
        from royalty_ledger y
       where y.territory_id = p_territory
         and y.business_day between v_from and v_to
       order by y.business_day;

  elsif p_dataset = 'invoices' then
    return next csv_line(array['invoice_id','period_start','period_end','amount_due',
                               'amount_settled','status','method','reference',
                               'issued_at','confirmed_at']);
    return query
      select csv_line(array[
        i.id::text, i.period_start::text, i.period_end::text, i.amount_due::text,
        i.amount_settled::text, i.status::text, i.method, i.reference,
        to_char(i.created_at at time zone v_tz, 'YYYY-MM-DD HH24:MI'),
        to_char(i.confirmed_at at time zone v_tz, 'YYYY-MM-DD HH24:MI')])
        from operator_settlements i
       where i.territory_id = p_territory
         and i.period_start <= v_to and i.period_end >= v_from
       order by i.period_start;

  else
    raise exception 'Unknown dataset %. Try deliveries, commissions, remittances, royalty or invoices.',
      p_dataset using errcode = 'check_violation';
  end if;

  perform log_action('hq.exported', 'export', p_dataset, p_territory,
                     jsonb_build_object('from', v_from, 'to', v_to));
end;
$$;
revoke all on function hq_export(text, uuid, date, date) from public;
grant execute on function hq_export(text, uuid, date, date) to authenticated;
