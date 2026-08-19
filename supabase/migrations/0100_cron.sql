-- ServdGo — the two jobs that have to run whether anyone is watching or not.
--
-- pg_cron rather than an external scheduler: both jobs are pure SQL, so there is
-- nothing to call over HTTP, and keeping the schedule in a migration means it is
-- versioned with the functions it runs instead of living in a dashboard nobody
-- reviews.
--
-- pg_cron is provided by the platform and is not present everywhere — a local
-- test harness or a plain Postgres will not have it. This skips rather than
-- fails there, and says so, because a migration that cannot be replayed on a
-- throwaway database stops the tests running at all.
--
-- Times are UTC, which is what pg_cron uses. Manila is UTC+8.
--   17:00 UTC        = 01:00 Manila — daily overdue sweep, after the settlement
--                                     day has closed
--   17:30 UTC on 1st = 01:30 Manila — monthly invoice run, for the month that
--                                     just ended

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available here — the overdue sweep and monthly invoicing are NOT scheduled. Run them by hand, or schedule them on a database that has it.';
    return;
  end if;

  execute 'create extension if not exists pg_cron';

  begin
    perform cron.unschedule('servdgo-overdue-sweep');
  exception when others then null;
  end;
  begin
    perform cron.unschedule('servdgo-monthly-invoicing');
  exception when others then null;
  end;

  perform cron.schedule('servdgo-overdue-sweep', '0 17 * * *',
                        'select public.sweep_overdue_territories();');
  perform cron.schedule('servdgo-monthly-invoicing', '30 17 1 * *',
                        'select public.run_monthly_invoicing();');

  raise notice 'scheduled: servdgo-overdue-sweep (daily), servdgo-monthly-invoicing (monthly)';
end $$;
