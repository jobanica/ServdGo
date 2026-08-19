/**
 * Who did what, and when.
 *
 * The log is append-only in the database — the franchisor cannot edit it either
 * — so this screen only ever reads. Actions are namespaced (`hq.`, `territory.`,
 * `merchant.`), and the filter matches on that prefix, which is how you ask for
 * "everything HQ did" without listing the actions.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { listAudit, listTerritories, type AuditEntry, type Territory } from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { Card, Muted, ErrorNote } from '../ui.tsx';

const QUICK = [
  { label: 'Everything', value: '' },
  { label: 'HQ actions', value: 'hq.' },
  { label: 'Cities', value: 'territory.' },
  { label: 'Restaurants', value: 'merchant.' },
];

export function Audit() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [cities, setCities] = useState<Territory[]>([]);
  const [action, setAction] = useState('');
  const [territoryId, setTerritoryId] = useState('');
  const [entityId, setEntityId] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    setError(null);
    try {
      setRows(await listAudit(supabase, {
        action: action || undefined,
        territoryId: territoryId || undefined,
        entityId: entityId.trim() || undefined,
        since: since ? new Date(since).toISOString() : undefined,
        // Through the end of the chosen day, not its first second.
        until: until ? new Date(new Date(until).getTime() + 86_400_000).toISOString() : undefined,
      }, 300));
    } catch (e) { setError(errMessage(e)); }
  }, [action, territoryId, entityId, since, until]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) return;
    void listTerritories(supabase).then(setCities).catch(() => setCities([]));
  }, []);

  if (!isSupabaseConfigured) return <Muted>Connect Supabase to read the audit log.</Muted>;

  return (
    <div className="space-y-5">
      {error && <ErrorNote msg={error} />}

      <Card title="Search">
        <div className="flex flex-wrap gap-2">
          {QUICK.map((q) => (
            <button key={q.label} onClick={() => setAction(q.value)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                action === q.value ? 'bg-brand-orange text-white' : 'bg-black/5 text-black/60'
              }`}>
              {q.label}
            </button>
          ))}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input value={action} onChange={(e) => setAction(e.target.value)}
            placeholder="Action starts with…"
            className="rounded-lg border border-black/10 px-3 py-2 text-sm" />
          <select value={territoryId} onChange={(e) => setTerritoryId(e.target.value)}
            className="rounded-lg border border-black/10 px-3 py-2 text-sm">
            <option value="">Every city</option>
            {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input value={entityId} onChange={(e) => setEntityId(e.target.value)}
            placeholder="Order or city id"
            className="rounded-lg border border-black/10 px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <input type="date" value={since} onChange={(e) => setSince(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-2 py-2 text-sm" />
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-2 py-2 text-sm" />
          </div>
        </div>
      </Card>

      <Card title={`${rows.length} entries`}>
        {rows.length === 0 ? <p className="text-sm text-black/50">Nothing matches.</p> : (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead className="border-b border-black/5 text-xs uppercase tracking-wide text-black/40">
                <tr>
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Action</th>
                  <th className="py-2 pr-4 font-medium">Who</th>
                  <th className="py-2 pr-4 font-medium">City</th>
                  <th className="py-2 pr-4 font-medium">Entity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                      className="cursor-pointer align-top hover:bg-black/[0.02]">
                      <td className="py-3 pr-4 whitespace-nowrap text-black/60">
                        {new Date(r.created_at).toLocaleString()}
                      </td>
                      <td className="py-3 pr-4 font-semibold">{r.action}</td>
                      <td className="py-3 pr-4 text-black/60">{r.actor_role ?? '—'}</td>
                      <td className="py-3 pr-4 text-black/60">
                        {cities.find((c) => c.id === r.territory_id)?.name ?? '—'}
                      </td>
                      <td className="py-3 pr-4 text-black/60">
                        {r.entity ? `${r.entity} ${(r.entity_id ?? '').slice(0, 8)}` : '—'}
                      </td>
                    </tr>
                    {expanded === r.id && r.diff && (
                      <tr>
                        <td colSpan={5} className="pb-3">
                          <pre className="overflow-x-auto rounded-xl bg-black/[0.03] p-3 text-xs">
                            {JSON.stringify(r.diff, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
