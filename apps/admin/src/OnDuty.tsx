import { useEffect, useState } from 'react';
import { listActiveRiders, onDutyRiders, type ActiveRider } from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase } from './lib/supabase.ts';
import { Card, ErrorNote } from './ui.tsx';
import { IconScooter } from './icons.tsx';

const today = new Date().toISOString().slice(0, 10);

/** How long they've been on duty: "just now", "35m", "3h 20m". */
export function onDutyFor(since: string | null): string | null {
  if (!since) return null;
  const mins = Math.floor((Date.now() - new Date(since).getTime()) / 60_000);
  if (!Number.isFinite(mins) || mins < 0) return null;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const chip: Record<string, string> = {
  on_delivery: 'bg-brand-charcoal/15 text-brand-charcoal',
  available: 'bg-brand-orange/15 text-green-800',
  locked: 'bg-red-100 text-red-700',
};
const label: Record<string, string> = {
  on_delivery: 'On delivery', available: 'Waiting for orders', locked: 'Locked — owes commission',
};

export const SAMPLE_RIDERS: ActiveRider[] = [
  { id: 'a', name: 'Ben Cruz', mobile_number: '0918 555 2000', vehicle: 'Motorcycle', is_locked: false, is_suspended: false, suspend_reason: null, is_online: true, online_since: new Date(Date.now() - 200 * 60000).toISOString(), owed: 9, overdue: 0, activity: 'on_delivery', activeOrder: { id: 'o1', service_type: 'food', status: 'on_the_way' } },
  { id: 'b', name: 'Cy Ramos', mobile_number: '0917 555 1000', vehicle: 'Motorcycle', is_locked: false, is_suspended: false, suspend_reason: null, is_online: true, online_since: new Date(Date.now() - 42 * 60000).toISOString(), owed: 0, overdue: 0, activity: 'available', activeOrder: null },
  { id: 'c', name: 'Dina Lim', mobile_number: '0919 555 3000', vehicle: 'Bicycle', is_locked: false, is_suspended: false, suspend_reason: null, is_online: false, online_since: null, owed: 0, overdue: 0, activity: 'offline', activeOrder: null },
];

/**
 * Who is on duty right now.
 *
 * The dashboard counted stores, applications and orders but never answered the
 * question an operator asks first thing in the morning: is anyone out there?
 * Polls on the same 30s cadence as the live orders board.
 */
export function OnDuty({ onNavigate, onCount }:
  { onNavigate: (tab: string) => void; onCount?: (n: number) => void }) {
  const [rows, setRows] = useState<ActiveRider[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      if (!supabase) { if (alive) { setRows(SAMPLE_RIDERS); onCount?.(onDutyRiders(SAMPLE_RIDERS).length); } return; }
      try {
        const all = await listActiveRiders(supabase, today);
        if (!alive) return;
        setRows(all); setError(null); onCount?.(onDutyRiders(all).length);
      } catch (e) { if (alive) setError(errMessage(e)); }
    }
    void load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const duty = rows ? onDutyRiders(rows) : [];

  return (
    <Card
      title={`On duty now${rows ? ` · ${duty.length}` : ''}`}
      action={<button onClick={() => onNavigate('ridersActive')} className="text-sm font-medium text-brand-charcoal">All riders →</button>}
    >
      {error && <ErrorNote msg={error} />}
      {!rows ? (
        <p className="text-sm text-black/40">Loading…</p>
      ) : duty.length === 0 ? (
        <p className="py-2 text-sm text-black/50">
          Nobody is online right now — customers can order, but no request will be picked up until a rider goes on duty.
        </p>
      ) : (
        <ul className="divide-y divide-black/5">
          {duty.map((r) => {
            const since = onDutyFor(r.online_since);
            return (
              <li key={r.id} className="flex items-center gap-3 py-2.5">
                <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-orange/15 text-green-700">
                  <IconScooter />
                  <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-brand-orange" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-brand-ink">{r.name}</span>
                  <span className="block truncate text-xs text-black/45">
                    {r.mobile_number}{r.vehicle ? ` · ${r.vehicle}` : ''}
                    {since ? ` · on duty ${since}` : ''}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${chip[r.activity] ?? 'bg-black/5 text-black/60'}`}>
                    {label[r.activity] ?? r.activity}
                  </span>
                  {r.activeOrder && (
                    <span className="text-[11px] capitalize text-black/40">
                      {r.activeOrder.service_type} · {r.activeOrder.status.replaceAll('_', ' ')}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
