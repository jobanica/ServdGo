-- ServdGo — a record of what somebody did must outlive the somebody.
--
-- Found while testing operator account creation: deleting a console account
-- failed with
--
--   update or delete on table "profiles" violates foreign key constraint
--   "audit_log_actor_user_id_fkey"
--
-- Fourteen columns across the schema stamp *who did this* — who confirmed a
-- settlement, who ticked a checklist item, who acknowledged an alert. Each was
-- a foreign key to profiles with no delete action, so any one of them made the
-- person undeletable, and the first sign of it was a raw constraint error in
-- somebody's face.
--
-- The two obvious fixes are both wrong here:
--
--   on delete cascade   deletes the history along with the person
--   on delete set null  keeps the history but erases who did it — which, on an
--                       append-only audit log and on a money record, is exactly
--                       the fact worth keeping
--
-- So: a "who did it" stamp is a **record, not a relationship**. The id stays as
-- a plain value, and the constraint goes. These columns are written by triggers
-- and by auth.uid(), never typed in, so the integrity the constraint was buying
-- was not integrity anybody was at risk of losing.
--
-- Columns that are genuinely relationships — a rider's profile, a customer's
-- profile, an open view-as session — keep their cascades and are untouched.

do $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select c.conname, c.conrelid::regclass::text as tbl
      from pg_constraint c
     where c.contype = 'f'
       and c.confrelid = 'public.profiles'::regclass
       and c.confdeltype = 'a'          -- no action: the ones that block
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    n := n + 1;
  end loop;
  raise notice 'released % actor stamps', n;
end $$;

comment on column audit_log.actor_user_id is
  'Who did it, as an id. Deliberately not a foreign key: the log has to outlive them.';
comment on column settlements.confirmed_by is
  'Who confirmed the payment. Kept as an id even if that account is later removed.';
comment on column operator_settlements.confirmed_by is
  'Who confirmed the payment. Kept as an id even if that account is later removed.';
