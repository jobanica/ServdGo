import { useEffect, useState } from 'react';
import { getUserActivity, type UserActivity } from '@ebd/supabase';
import { supabase } from './lib/supabase.ts';
import { Card, Muted, ErrorNote } from './ui.tsx';
import { errMessage } from '@ebd/shared';

const SAMPLE: UserActivity = {
  window_days: 30,
  customers_total: 128, customers_active: 74, customers_new: 19,
  riders_total: 12, riders_active: 9, riders_online: 3, riders_suspended: 1, riders_pending: 2,
  installs_total: 96, installs_customer: 81, installs_rider: 15, installs_new: 12,
  orders_in_window: 214,
};

const WINDOWS = [7, 30, 90];

/**
 * Adoption + engagement monitor: how many people installed each app, and how
 * many of the registered customers/riders actually used the service inside the
 * selected window.
 */
export function UserMonitor() {
  const [days, setDays] = useState(30);
  const [d, setD] = useState<UserActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      if (!supabase) { setD(SAMPLE); setLoading(false); return; }
      setLoading(true);
      try {
        const res = await getUserActivity(supabase, days);
        if (alive) { setD(res); setError(null); }
      } catch (e) {
        if (alive) setError(errMessage(e));
      } finally { if (alive) setLoading(false); }
    }
    void load();
    return () => { alive = false; };
  }, [days]);

  if (loading && !d) return <Muted>Loading…</Muted>;
  if (error) return <ErrorNote msg={error} />;
  if (!d) return <Muted>No data.</Muted>;

  const custInactive = Math.max(0, d.customers_total - d.customers_active);
  const riderInactive = Math.max(0, d.riders_total - d.riders_active);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-black/50">Active means used in the last</span>
        {WINDOWS.map((w) => (
          <button key={w} onClick={() => setDays(w)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 ${
              days === w ? 'bg-brand-green text-white ring-brand-green' : 'bg-white text-black/60 ring-black/10'
            }`}>
            {w} days
          </button>
        ))}
      </div>

      {/* Installs */}
      <Card title="App installs">
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Total installs" value={d.installs_total} tint="text-brand-ink" />
          <Stat label="Customer app" value={d.installs_customer} tint="text-brand-green" />
          <Stat label="Rider app" value={d.installs_rider} tint="text-brand-purple" />
          <Stat label={`New (${d.window_days}d)`} value={d.installs_new} tint="text-brand-ink" />
        </div>
        <p className="mt-3 text-xs text-black/40">
          Counted once per device when someone installs the app to their home screen
          (or opens the packaged rider app). Browsing the site without installing isn't counted.
        </p>
      </Card>

      {/* Customers */}
      <Card title="Customers">
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Registered" value={d.customers_total} tint="text-brand-ink" />
          <Stat label="Active" value={d.customers_active} tint="text-brand-green" />
          <Stat label="Inactive" value={custInactive} tint="text-black/40" />
          <Stat label={`New (${d.window_days}d)`} value={d.customers_new} tint="text-brand-purple" />
        </div>
        <Bar active={d.customers_active} total={d.customers_total} />
      </Card>

      {/* Riders */}
      <Card title="Riders">
        <div className="grid gap-3 sm:grid-cols-5">
          <Stat label="Approved" value={d.riders_total} tint="text-brand-ink" />
          <Stat label="Active" value={d.riders_active} tint="text-brand-green" />
          <Stat label="Inactive" value={riderInactive} tint="text-black/40" />
          <Stat label="Online now" value={d.riders_online} tint="text-brand-purple" />
          <Stat label="Suspended" value={d.riders_suspended} tint="text-red-600" />
        </div>
        <Bar active={d.riders_active} total={d.riders_total} />
        {d.riders_pending > 0 && (
          <p className="mt-2 text-xs text-black/50">{d.riders_pending} application(s) awaiting review.</p>
        )}
      </Card>

      <Card title={`Orders in the last ${d.window_days} days`}>
        <p className="text-3xl font-black text-brand-ink">{d.orders_in_window}</p>
      </Card>
    </div>
  );
}

function Stat({ label, value, tint }: { label: string; value: number; tint: string }) {
  return (
    <div className="rounded-xl bg-black/[0.02] p-3 ring-1 ring-black/5">
      <p className="text-xs text-black/45">{label}</p>
      <p className={`mt-0.5 text-2xl font-black ${tint}`}>{value}</p>
    </div>
  );
}

/** Active share of the registered base. */
function Bar({ active, total }: { active: number; total: number }) {
  const pct = total > 0 ? Math.round((active / total) * 100) : 0;
  return (
    <div className="mt-3">
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-black/10">
        <div className="h-full rounded-full bg-brand-green" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-xs text-black/50">{pct}% of registered accounts were active</p>
    </div>
  );
}
