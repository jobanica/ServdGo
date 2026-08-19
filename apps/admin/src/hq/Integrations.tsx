/**
 * Which partner platforms are actually connected, and to what.
 *
 * "Connected" is not a flag anybody sets — it is three observations: a key that
 * has been used recently, calls in the last thirty days, and callbacks that are
 * getting through. A restaurant with keys and no calls is set up but not live,
 * which is worth seeing before somebody asks why no orders are arriving.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  merchantHealth, keyUsage, revokeMerchantKey, createMerchantKey,
  type MerchantHealth, type KeyUsage,
} from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { Card, Muted, ErrorNote } from '../ui.tsx';

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

function Health({ row }: { row: MerchantHealth }) {
  const quiet = !row.last_call_at
    || Date.now() - new Date(row.last_call_at).getTime() > 7 * 86_400_000;
  const label = !row.is_active ? 'Off'
    : row.webhooks_failed > 0 ? 'Callbacks failing'
    : quiet ? 'Quiet'
    : 'Live';
  const tone = label === 'Live' ? 'bg-brand-orange/15 text-green-800'
    : label === 'Callbacks failing' ? 'bg-red-100 text-red-700'
    : 'bg-black/5 text-black/60';
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}

export function Integrations() {
  const [rows, setRows] = useState<MerchantHealth[]>([]);
  const [keys, setKeys] = useState<KeyUsage[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    setError(null);
    try {
      const [h, k] = await Promise.all([merchantHealth(supabase), keyUsage(supabase)]);
      setRows(h); setKeys(k);
    } catch (e) { setError(errMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  if (!isSupabaseConfigured) return <Muted>Connect Supabase to see the integrations.</Muted>;

  return (
    <div className="space-y-5">
      {error && <ErrorNote msg={error} />}
      {newKey && (
        <div className="rounded-2xl bg-brand-yellow/20 p-4 text-sm ring-1 ring-brand-yellow">
          <p className="font-bold">Copy this key now — it is not stored and cannot be shown again.</p>
          <code className="mt-2 block break-all rounded-lg bg-white px-3 py-2">{newKey}</code>
          <button onClick={() => setNewKey(null)}
            className="mt-2 rounded-lg px-2 py-1 text-xs font-semibold text-black/60 hover:bg-black/5">
            Done
          </button>
        </div>
      )}

      <Card title="Connection health">
        {rows.length === 0 ? <p className="text-sm text-black/50">No partner restaurants yet.</p> : (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <thead className="border-b border-black/5 text-xs uppercase tracking-wide text-black/40">
                <tr>
                  <th className="py-2 pr-4 font-medium">Restaurant</th>
                  <th className="py-2 pr-4 font-medium">City</th>
                  <th className="py-2 pr-4 font-medium">State</th>
                  <th className="py-2 pr-4 font-medium">Last call</th>
                  <th className="py-2 pr-4 font-medium">Calls 30d</th>
                  <th className="py-2 pr-4 font-medium">Orders 30d</th>
                  <th className="py-2 pr-4 font-medium">Callbacks</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {rows.map((r) => (
                  <tr key={r.merchant_id} className="align-top">
                    <td className="py-3 pr-4">
                      <p className="font-semibold">{r.merchant_name}</p>
                      <p className="text-xs text-black/40">
                        {r.active_keys} active key{r.active_keys === 1 ? '' : 's'}
                        {r.webhook_url ? '' : ' · no callback URL'}
                      </p>
                    </td>
                    <td className="py-3 pr-4 text-black/60">{r.territory_name ?? '—'}</td>
                    <td className="py-3 pr-4"><Health row={r} /></td>
                    <td className="py-3 pr-4 text-black/60">{ago(r.last_call_at)}</td>
                    <td className="py-3 pr-4 font-semibold">{r.calls}</td>
                    <td className="py-3 pr-4">{r.orders_placed}</td>
                    <td className="py-3 pr-4">
                      {r.webhooks_failed > 0
                        ? <span className="text-red-700">{r.webhooks_failed} failed</span>
                        : r.webhooks_pending > 0
                          ? <span className="text-yellow-800">{r.webhooks_pending} queued</span>
                          : <span className="text-black/40">clear</span>}
                      {r.last_error && (
                        <p className="mt-1 max-w-[16rem] truncate text-xs text-black/40" title={r.last_error}>
                          {r.last_error}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="API keys">
        {keys.length === 0 ? <p className="text-sm text-black/50">No keys issued.</p> : (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead className="border-b border-black/5 text-xs uppercase tracking-wide text-black/40">
                <tr>
                  <th className="py-2 pr-4 font-medium">Key</th>
                  <th className="py-2 pr-4 font-medium">Restaurant</th>
                  <th className="py-2 pr-4 font-medium">Issued</th>
                  <th className="py-2 pr-4 font-medium">Last used</th>
                  <th className="py-2 pr-4 font-medium">Calls 30d</th>
                  <th className="py-2 pr-4 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {keys.map((k) => (
                  <tr key={k.key_id} className={k.revoked_at ? 'text-black/35' : ''}>
                    <td className="py-3 pr-4">
                      <code className="text-xs">{k.prefix}…</code>
                      {k.label && <span className="ml-2 text-xs text-black/50">{k.label}</span>}
                      {k.revoked_at && <span className="ml-2 text-xs">revoked</span>}
                    </td>
                    <td className="py-3 pr-4">{k.merchant_name}</td>
                    <td className="py-3 pr-4 text-black/60">
                      {new Date(k.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-3 pr-4 text-black/60">{ago(k.last_used_at)}</td>
                    <td className="py-3 pr-4 font-semibold">{k.calls}</td>
                    <td className="py-3 pr-4 text-right">
                      {!k.revoked_at && (
                        <>
                          <button disabled={busy}
                            onClick={() => void run(async () => {
                              setNewKey(await createMerchantKey(supabase!, k.merchant_id, 'rotated'));
                              await revokeMerchantKey(supabase!, k.key_id);
                            })}
                            className="rounded-lg px-2 py-1 text-xs font-semibold text-black/60 hover:bg-black/5">
                            Rotate
                          </button>
                          <button disabled={busy}
                            onClick={() => void run(() => revokeMerchantKey(supabase!, k.key_id))}
                            className="rounded-lg px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50">
                            Revoke
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-black/45">
          Rotating issues a new key and revokes this one immediately — hand the new key over
          before rotating, not after.
        </p>
      </Card>
    </div>
  );
}
