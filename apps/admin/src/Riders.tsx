import { useEffect, useState } from 'react';
import { listActiveRiders, setRiderLocked, setRiderSuspended, deleteRider, type ActiveRider } from '@servdgo/supabase';
import { supabase } from './lib/supabase.ts';
import { Card, Th, Td, Muted, ErrorNote, peso } from './ui.tsx';
import { errMessage } from '@servdgo/shared';
import { SAMPLE_RIDERS, onDutyFor } from './OnDuty.tsx';
import { RefusalHistory, PinCorrectionLog } from './Refusals.tsx';

const today = new Date().toISOString().slice(0, 10);

const activityChip: Record<string, string> = {
  on_delivery: 'bg-brand-purple/15 text-brand-purple',
  available: 'bg-brand-green/15 text-green-800',
  offline: 'bg-black/[0.06] text-black/50',
  locked: 'bg-red-100 text-red-700',
  suspended: 'bg-black/70 text-white',
};
const activityLabel: Record<string, string> = {
  on_delivery: 'On delivery', available: 'Online — waiting', offline: 'Offline',
  locked: 'Locked', suspended: 'Suspended',
};

export function Riders() {
  const [rows, setRows] = useState<ActiveRider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!supabase) { setRows(SAMPLE_RIDERS); setLoading(false); return; }
    setLoading(true);
    try { setRows(await listActiveRiders(supabase, today)); setError(null); }
    catch (e) { setError(errMessage(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function toggleLock(r: ActiveRider) {
    if (!supabase) {
      setRows((rs) => rs.map((x) => x.id === r.id ? { ...x, is_locked: !x.is_locked, activity: !x.is_locked ? 'locked' : (x.activeOrder ? 'on_delivery' : 'available') } : x));
      return;
    }
    await setRiderLocked(supabase, r.id, !r.is_locked);
    await load();
  }

  async function toggleSuspend(r: ActiveRider) {
    if (!supabase) return;
    if (r.is_suspended) {
      if (!window.confirm(`Reinstate ${r.name}?`)) return;
      await setRiderSuspended(supabase, r.id, false);
    } else {
      const reason = window.prompt(`Suspend ${r.name}? They won't be able to go online or accept orders.\n\nReason (optional):`, '');
      if (reason === null) return;
      await setRiderSuspended(supabase, r.id, true, reason.trim() || undefined);
    }
    await load();
  }

  async function removeRider(r: ActiveRider) {
    if (!supabase) return;
    if (!window.confirm(`Delete ${r.name}? This permanently removes the rider account.`)) return;
    try {
      const res = await deleteRider(supabase, r.id);
      if (!res.deleted) { window.alert(res.message ?? 'This rider could not be deleted.'); return; }
      await load();
    } catch (e) { setError(errMessage(e)); }
  }

  if (loading) return <Muted>Loading…</Muted>;
  if (error) return <ErrorNote msg={error} />;
  if (rows.length === 0) return <Muted>No approved riders yet.</Muted>;

  const onDelivery = rows.filter((r) => r.activity === 'on_delivery').length;
  const available = rows.filter((r) => r.activity === 'available').length;
  const offline = rows.filter((r) => r.activity === 'offline').length;
  const locked = rows.filter((r) => r.activity === 'locked').length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Mini label="On delivery" value={onDelivery} tint="bg-brand-purple/15 text-brand-purple" />
        <Mini label="Online — waiting" value={available} tint="bg-brand-green/15 text-green-800" />
        <Mini label="Offline" value={offline} tint="bg-black/[0.06] text-black/50" />
        <Mini label="Locked" value={locked} tint="bg-red-100 text-red-700" />
      </div>

      <Card title="Approved riders">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-black/50">
              <tr className="border-b border-black/5">
                <Th>Rider</Th><Th>Status</Th><Th>Current delivery</Th><Th>Owed</Th><Th> </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-black/[0.04]">
                  <Td>
                    <span className="block font-medium">{r.name}</span>
                    <span className="block text-xs text-black/40">{r.mobile_number} · {r.vehicle ?? '—'}</span>
                  </Td>
                  <Td>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${activityChip[r.activity]}`}>{activityLabel[r.activity]}</span>
                    {r.is_online && onDutyFor(r.online_since) && (
                      <span className="mt-0.5 block text-xs text-black/40">on duty {onDutyFor(r.online_since)}</span>
                    )}
                  </Td>
                  <Td>
                    {r.activeOrder
                      ? <span className="capitalize">{r.activeOrder.service_type} · {r.activeOrder.status.replaceAll('_', ' ')}</span>
                      : <span className="text-black/30">—</span>}
                  </Td>
                  <Td>
                    <span className={r.overdue > 0 ? 'font-medium text-red-600' : ''}>{peso(r.owed)}</span>
                    {r.overdue > 0 && <span className="block text-xs text-red-500">{peso(r.overdue)} overdue</span>}
                  </Td>
                  <Td>
                    <span className="flex flex-wrap gap-1.5">
                      <button onClick={() => toggleLock(r)}
                        className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                          r.is_locked ? 'bg-brand-green text-white' : 'border border-red-300 text-red-600'
                        }`}>
                        {r.is_locked ? 'Unlock' : 'Lock'}
                      </button>
                      <button onClick={() => toggleSuspend(r)}
                        title={r.suspend_reason ?? undefined}
                        className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                          r.is_suspended ? 'bg-brand-green text-white' : 'border border-black/20 text-black/70'
                        }`}>
                        {r.is_suspended ? 'Reinstate' : 'Suspend'}
                      </button>
                      <button onClick={() => removeRider(r)}
                        className="rounded-lg border border-red-400 px-3 py-1.5 text-xs font-semibold text-red-700">
                        Delete
                      </button>
                    </span>
                    {r.is_suspended && r.suspend_reason && (
                      <span className="mt-1 block text-xs text-black/40">Reason: {r.suspend_reason}</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <RefusalHistory />
      <PinCorrectionLog />
    </div>
  );
}

function Mini({ label, value, tint }: { label: string; value: number; tint: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 text-center shadow-sm ring-1 ring-black/5">
      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tint}`}>{label}</span>
      <div className="mt-1 text-2xl font-extrabold">{value}</div>
    </div>
  );
}
