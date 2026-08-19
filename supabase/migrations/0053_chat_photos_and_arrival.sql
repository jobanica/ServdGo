-- Two things the chat couldn't do, and one the rider couldn't say.
--
-- 1. Photos in the order chat. "Is this the right brand?" is a picture, not a
--    paragraph — for every service, both directions.
-- 2. "I'm outside." The status flow jumps straight from on_the_way to
--    delivered, so there was no way to say "I'm at your gate" except ringing.
--    A separate marker keeps the enum and every transition rule untouched.

alter table order_messages
  add column if not exists image_url text;

-- body is no longer the only payload: a photo can travel on its own.
alter table order_messages
  alter column body drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_messages_has_content') then
    alter table order_messages add constraint order_messages_has_content
      check (coalesce(btrim(body), '') <> '' or coalesce(btrim(image_url), '') <> '');
  end if;
end $$;

alter table orders
  add column if not exists arrived_at timestamptz;

comment on column orders.arrived_at is
  'Set when the rider says they are at the drop-off. Not a status — the flow is unchanged.';

/* The rider announces arrival. Posts into the chat the customer already
   watches, so the alert rides the realtime subscription that exists. */
create or replace function rider_mark_arrived(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_rider uuid := current_rider_id();
begin
  if v_rider is null then raise exception 'not a rider'; end if;

  update orders set arrived_at = now()
   where id = p_order_id
     and rider_id = v_rider
     and status not in ('delivered', 'cancelled');
  if not found then
    raise exception 'You can only do that on your own active delivery.';
  end if;

  perform post_order_system_message(p_order_id, 'rider',
    '🛵 I''m outside with your order — please come out when you can.');
end;
$$;

revoke all on function rider_mark_arrived(uuid) from public;
grant execute on function rider_mark_arrived(uuid) to authenticated;

-- Chat photos live beside the other order attachments in the public bucket.
drop policy if exists chat_photo_insert on storage.objects;
create policy chat_photo_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'chat-photos');

drop policy if exists chat_photo_update on storage.objects;
create policy chat_photo_update on storage.objects
  for update to authenticated
  using (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'chat-photos')
  with check (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'chat-photos');
