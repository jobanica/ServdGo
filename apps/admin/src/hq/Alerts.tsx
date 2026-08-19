/**
 * The queue of things that need somebody.
 *
 * Alerts are generated, deduped while they stay true, and closed by
 * acknowledging them — at which point the same condition may raise a new one.
 * That is deliberate: an alert that can never re-fire is a silence nobody asked
 * for.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listAlerts, acknowledgeAlert, generateAlerts,
  type Alert, type AlertSeverity,
} from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { Card, Muted, ErrorNote } from '../ui.tsx';

const TONE: Record<AlertSeverity, string> = {
  critical: 'bg-brand-orange/20 text-brand-orange',
  warning: 'bg-brand-yellow/30 text-yellow-800',
  info: 'bg-black/5 text-black/60',
};

const SAMPLE: Alert[] = [
  { id: 1, territory_id: 't1', kind: 'no_riders_online', severity: 'critical',
    title: 'Preview city has no riders online',
    detail: 'The city is open and nobody is available to take an order.',
    entity: 'territory', entity_id: 't1', acknowledged_by: null, acknowledged_at: null,
    created_at: new Date().toISOString() },
];

export function Alerts() {
  const navigate = useNavigate();
  const [showClosed, setShowClosed] = useState(false);
  const [rows, setRows] = useState<Alert[]>(isSupabaseConfigured ? [] : SAMPLE);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    setError(null);
    try { setRows(await listAlerts(supabase, { openOnly: !showClosed })); }
    catch (e) { setError(errMessage(e)); }
  }, [showClosed]);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); await load(); }
    catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  const open = rows.filter((r) => !r.acknowledged_at);
  const critical = open.filter((r) => r.severity === 'critical').length;

  return (
    <div className="space-y-5">
      {error && <ErrorNote msg={error} />}
      {note && <p className="rounded-xl bg-brand-orange/10 px-3 py-2 text-sm text-brand-orange">{note}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
          <p className="text-xs font-semibold uppercase tracking-wide text-black/40">Open</p>
          <p className="mt-1 text-2xl font-extrabold">{open.length}</p>
        </div>
        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
          <p className="text-xs font-semibold uppercase tracking-wide text-black/40">Critical</p>
          <p className={`mt-1 text-2xl font-extrabold ${critical > 0 ? 'text-brand-orange' : ''}`}>{critical}</p>
        </div>
      </div>

      <Card title={showClosed ? 'All alerts' : 'Open alerts'} action={
        <div className="flex gap-2">
          <button onClick={() => setShowClosed((v) => !v)}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 ring-black/10 hover:bg-black/5">
            {showClosed ? 'Open only' : 'Include closed'}
          </button>
          <button disabled={busy}
            onClick={() => void run(async () => {
              const n = await generateAlerts(supabase!);
              setNote(n === 0 ? 'Nothing new — everything already raised or clear.' : `${n} new alert${n === 1 ? '' : 's'}.`);
            })}
            className="rounded-lg bg-brand-orange px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">
            Check now
          </button>
        </div>
      }>
        {rows.length === 0 ? (
          <Muted>Nothing to look at. The sweep runs every 15 minutes.</Muted>
        ) : (
          <ul className="space-y-2">
            {rows.map((a) => (
              <li key={a.id} className={`rounded-xl px-3 py-2.5 ${a.acknowledged_at ? 'opacity-50' : ''} bg-black/[0.02]`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${TONE[a.severity]}`}>
                        {a.severity}
                      </span>
                      {a.title}
                    </p>
                    {a.detail && <p className="mt-0.5 text-xs text-black/60">{a.detail}</p>}
                    <p className="mt-0.5 text-xs text-black/40">
                      <code>{a.kind}</code> · {new Date(a.created_at).toLocaleString()}
                      {a.acknowledged_at ? ` · closed ${new Date(a.acknowledged_at).toLocaleString()}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {a.entity === 'territory' && a.entity_id && (
                      <button onClick={() => navigate(`/hq/tenants/${a.entity_id}`)}
                        className="rounded-lg px-2.5 py-1 text-xs font-semibold ring-1 ring-black/10 hover:bg-black/5">
                        Open city
                      </button>
                    )}
                    {!a.acknowledged_at && (
                      <button disabled={busy}
                        onClick={() => void run(() => acknowledgeAlert(supabase!, a.id))}
                        className="rounded-lg bg-brand-orange px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">
                        Acknowledge
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Muted>
          A condition that stays true raises one alert, not one every sweep. Acknowledging closes
          it; if the condition is still there next time, it raises a fresh one.
        </Muted>
      </Card>
    </div>
  );
}
