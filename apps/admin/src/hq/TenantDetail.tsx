/**
 * One city, everything about it.
 *
 * The gates shown here are all enforced in Postgres — the checklist, the
 * boundary overlap, who may change what. This screen's job is to make the rules
 * visible before somebody hits them, not to be the rule.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  getTerritory, setTerritoryBoundary, listChecklist, setChecklistItem,
  approveTerritory, goLive, suspendTerritory, terminateTerritory,
  listDocuments, listConfigHistory, checkOverlap, signedDocumentUrl,
  TERRITORY_STATUS_LABEL, listStaff,
  type Territory, type ChecklistItem, type TerritoryDocument, type ConfigChange,
  type StaffMember,
} from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { Card, Muted, ErrorNote, Th, Td, peso } from '../ui.tsx';
import { ViewAsButton } from './ViewAs.tsx';
import { OperatorAccount } from './OperatorAccount.tsx';
import { Export } from './Export.tsx';

const inp = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/30';
const TABS = ['Overview', 'Checklist', 'Documents', 'Territory', 'Rev-share', 'Export', 'Actions'] as const;
type TabName = typeof TABS[number];

export function TenantDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabName>('Overview');
  const [t, setT] = useState<Territory | null>(null);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [docs, setDocs] = useState<TerritoryDocument[]>([]);
  const [history, setHistory] = useState<ConfigChange[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured || !id) return;
    setError(null);
    try {
      const [terr, cl, dc, hs, st] = await Promise.all([
        getTerritory(supabase, id),
        listChecklist(supabase, id),
        listDocuments(supabase, id),
        listConfigHistory(supabase, id),
        listStaff(supabase, id),
      ]);
      setT(terr); setChecklist(cl); setDocs(dc); setHistory(hs); setStaff(st);
    } catch (e) { setError(errMessage(e)); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); if (ok) setNote(ok); await load(); }
    catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  if (!isSupabaseConfigured) return <Muted>Preview mode — connect Supabase to manage cities.</Muted>;
  if (!t) return error ? <ErrorNote msg={error} /> : <Muted>Loading…</Muted>;

  const outstanding = checklist.filter((c) => !c.done);

  return (
    <div className="space-y-5">
      <button onClick={() => navigate('/hq/tenants')}
        className="text-sm font-semibold text-brand-orange hover:underline">← All cities</button>

      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-xl font-extrabold">{t.name}</h2>
        <span className="rounded-full bg-brand-orange/15 px-2.5 py-0.5 text-xs font-semibold uppercase text-brand-orange">
          {TERRITORY_STATUS_LABEL[t.status]}
        </span>
        <span className="text-sm text-black/40">{t.slug}</span>
      </div>

      {error && <ErrorNote msg={error} />}
      {note && <p className="rounded-xl bg-brand-orange/10 px-3 py-2 text-sm text-brand-orange">{note}</p>}

      {/* Tabs scroll rather than wrap — this is used on a phone. */}
      <div className="-mx-4 overflow-x-auto px-4">
        <div className="flex gap-1 border-b border-black/10">
          {TABS.map((name) => (
            <button key={name} onClick={() => setTab(name)}
              className={`whitespace-nowrap px-3 py-2 text-sm font-semibold ${
                tab === name ? 'border-b-2 border-brand-orange text-brand-orange' : 'text-black/50'}`}>
              {name}
              {name === 'Checklist' && outstanding.length > 0 && (
                <span className="ml-1.5 rounded-full bg-brand-yellow/40 px-1.5 text-[10px] text-yellow-900">
                  {outstanding.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {tab === 'Overview' && (
        <Card title="At a glance">
          <dl className="grid gap-3 sm:grid-cols-2">
            <Row k="Commission rate" v={`${(Number(t.commission_rate) * 100).toFixed(1)}%`} />
            <Row k="Operator" v={t.operator_profile_id ? 'appointed' : 'none appointed'} />
            <Row k="Boundary" v={t.service_radius_km > 0
              ? `${t.service_center_lat?.toFixed(4)}, ${t.service_center_lng?.toFixed(4)} · ${t.service_radius_km} km`
              : 'not drawn'} />
            <Row k="Open for orders" v={t.is_open ? 'yes' : 'no'} />
            <Row k="Mark-up share" v={`${(Number(t.markup_operator_share) * 100).toFixed(0)}%`} />
            <Row k="Created" v={new Date(t.created_at).toLocaleDateString()} />
          </dl>
        </Card>
      )}

      {tab === 'Checklist' && (
        <Card title="Before this city can trade">
          <ul className="space-y-1">
            {checklist.map((c) => (
              <li key={c.id} className="flex items-start gap-3 rounded-xl px-2 py-2 hover:bg-black/[0.02]">
                <input type="checkbox" checked={c.done} disabled={c.auto || busy}
                  onChange={(e) => void run(
                    () => setChecklistItem(supabase!, id, c.item_key, e.target.checked))}
                  className="mt-1 h-4 w-4 accent-[#E8552F] disabled:opacity-40" />
                <span className="min-w-0">
                  <span className={`block text-sm font-medium ${c.done ? 'text-black/50 line-through' : ''}`}>
                    {c.label}
                  </span>
                  <span className="block text-xs text-black/40">
                    {c.auto
                      ? 'Checked automatically — the database can see this one'
                      : c.done_at ? `Ticked ${new Date(c.done_at).toLocaleString()}` : 'Not yet done'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <Muted>
            A city cannot be opened while anything here is outstanding, and the rule is in the
            database — opening it any other way is refused too.
          </Muted>
        </Card>
      )}

      {tab === 'Documents' && (
        <Card title="Paperwork">
          {docs.length === 0 ? <Muted>Nothing on file.</Muted> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead><tr><Th>Kind</Th><Th>Label</Th><Th>Expires</Th><Th>{''}</Th></tr></thead>
                <tbody>
                  {docs.map((d) => {
                    const days = d.expires_at
                      ? Math.round((new Date(d.expires_at).getTime() - Date.now()) / 86400000) : null;
                    return (
                      <tr key={d.id} className="border-t border-black/5">
                        <Td>{d.kind}</Td>
                        <Td>{d.label ?? '—'}</Td>
                        <Td>
                          {d.expires_at ? (
                            <span className={days !== null && days < 30 ? 'font-semibold text-brand-orange' : ''}>
                              {d.expires_at}{days !== null && days < 30 ? ` · ${days} days` : ''}
                            </span>
                          ) : 'no expiry'}
                        </Td>
                        <Td>
                          <button onClick={() => void run(async () => {
                            const url = await signedDocumentUrl(supabase!, d.file_url);
                            window.open(url, '_blank', 'noopener');
                          })}
                            className="rounded-lg px-2.5 py-1 text-xs font-semibold ring-1 ring-black/10 hover:bg-black/5">
                            View
                          </button>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Muted>Stored in a private bucket and opened through a short-lived signed link, never a public URL.</Muted>
        </Card>
      )}

      {tab === 'Territory' && <BoundaryEditor t={t} onSaved={load} />}

      {tab === 'Rev-share' && (
        <Card title="What changed, and when">
          {history.length === 0 ? <Muted>No changes recorded yet.</Muted> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead><tr><Th>Field</Th><Th>From</Th><Th>To</Th><Th>When</Th></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id} className="border-t border-black/5">
                      <Td><code className="text-xs">{h.field}</code></Td>
                      <Td>{h.old_value ?? '—'}</Td>
                      <Td className="font-semibold">{h.new_value ?? '—'}</Td>
                      <Td>{new Date(h.changed_at).toLocaleString()}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Muted>Written by a database trigger, so a change cannot be made without leaving a record.</Muted>
        </Card>
      )}

      {tab === 'Export' && <Export territory={t} />}

      {tab === 'Actions' && (
        <Actions t={t} outstanding={outstanding.length} busy={busy} run={run}
          staff={staff} onStaffChanged={load} />
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-xl bg-black/[0.02] px-3 py-2">
      <dt className="text-xs font-semibold uppercase tracking-wide text-black/40">{k}</dt>
      <dd className="text-sm font-medium">{v}</dd>
    </div>
  );
}

/**
 * The boundary, with the overlap check run before saving rather than after —
 * the database refuses an overlap anyway, but being told which city you clash
 * with while you are still dragging the radius is the difference between a
 * useful tool and a rejection.
 */
function BoundaryEditor({ t, onSaved }: { t: Territory; onSaved: () => Promise<void> }) {
  const [lat, setLat] = useState(String(t.service_center_lat ?? ''));
  const [lng, setLng] = useState(String(t.service_center_lng ?? ''));
  const [radius, setRadius] = useState(String(t.service_radius_km ?? ''));
  const [clash, setClash] = useState<{ name: string; overlap_km: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nums = { lat: Number(lat), lng: Number(lng), radiusKm: Number(radius) };
  const valid = [nums.lat, nums.lng, nums.radiusKm].every(Number.isFinite) && nums.radiusKm > 0;

  useEffect(() => {
    if (!supabase || !valid) { setClash([]); return; }
    let cancelled = false;
    const id = setTimeout(() => {
      checkOverlap(supabase!, { ...nums, excludeTerritoryId: t.id })
        .then((c) => { if (!cancelled) setClash(c); })
        .catch(() => { if (!cancelled) setClash([]); });
    }, 400);
    return () => { cancelled = true; clearTimeout(id); };
  }, [lat, lng, radius]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card title="Boundary">
      <p className="text-sm text-black/60">
        A city is a centre and a radius. The pickup decides which city an order belongs to, so this
        is what routes work — and two cities may not overlap.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="block"><span className="mb-1 block text-sm font-medium">Centre latitude</span>
          <input className={inp} value={lat} inputMode="decimal" onChange={(e) => setLat(e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-sm font-medium">Centre longitude</span>
          <input className={inp} value={lng} inputMode="decimal" onChange={(e) => setLng(e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-sm font-medium">Radius (km)</span>
          <input className={inp} value={radius} inputMode="decimal" onChange={(e) => setRadius(e.target.value)} /></label>
      </div>

      {clash.length > 0 && (
        <p className="mt-3 rounded-xl bg-brand-yellow/25 px-3 py-2 text-sm text-yellow-900">
          Overlaps {clash.map((c) => `${c.name} (by ~${c.overlap_km} km)`).join(', ')}. Saving will be refused.
        </p>
      )}
      {error && <ErrorNote msg={error} />}

      <button disabled={busy || !valid || clash.length > 0}
        onClick={async () => {
          if (!supabase) return;
          setBusy(true); setError(null);
          try { await setTerritoryBoundary(supabase, t.id, nums); await onSaved(); }
          catch (e) { setError(errMessage(e)); }
          finally { setBusy(false); }
        }}
        className="mt-3 rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
        {busy ? 'Saving…' : 'Save boundary'}
      </button>
      <Muted>Only the franchisor can move a boundary; an operator's save is refused by the database.</Muted>
    </Card>
  );
}

function Actions({ t, outstanding, busy, run, staff, onStaffChanged }: {
  t: Territory; outstanding: number; busy: boolean;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
  staff: StaffMember[]; onStaffChanged: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');

  return (
    <div className="space-y-4">
      <Card title="Move it along">
        <div className="flex flex-wrap gap-2">
          <button disabled={busy || t.status !== 'applied' && t.status !== 'lead'}
            onClick={() => void run(() => approveTerritory(supabase!, t.id), 'Approved.')}
            className="rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-40">
            Approve
          </button>
          <button disabled={busy || t.status === 'live' || outstanding > 0}
            onClick={() => void run(() => goLive(supabase!, t.id), 'This city is now live.')}
            className="rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-40">
            Open for business
          </button>
        </div>
        {outstanding > 0 && (
          <Muted>{outstanding} checklist item{outstanding === 1 ? '' : 's'} still outstanding — opening is refused until they are clear.</Muted>
        )}
      </Card>

      <OperatorAccount territory={t} staff={staff} onCreated={onStaffChanged} />

      <Card title="See it as they see it">
        <p className="text-sm text-black/60">
          Opens the console as this city's operator — their rows, their blind spots, and no way
          to change anything while you are in there. The visit is recorded.
        </p>
        <div className="mt-3"><ViewAsButton territory={t} /></div>
      </Card>

      <Card title="Suspend">
        <p className="text-sm text-black/60">
          Stops new orders. Everything already in the queue is still delivered and settled.
        </p>
        <input className={`${inp} mt-2`} placeholder="Reason shown to customers (optional)"
          value={reason} onChange={(e) => setReason(e.target.value)} />
        <button disabled={busy || t.status === 'suspended'}
          onClick={() => void run(() => suspendTerritory(supabase!, t.id, reason || undefined), 'Suspended.')}
          className="mt-3 rounded-xl px-4 py-2 text-sm font-semibold ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-40">
          Suspend this city
        </button>
      </Card>

      <Card title="Terminate">
        <p className="text-sm text-black/60">
          Ends the franchise. History is kept, but the ground is released for another operator.
          Type <b>{t.name}</b> to confirm.
        </p>
        <input className={`${inp} mt-2`} value={typed} placeholder={t.name}
          onChange={(e) => setTyped(e.target.value)} />
        <button disabled={busy || typed !== t.name || t.status === 'terminated'}
          onClick={() => void run(() => terminateTerritory(supabase!, t.id), 'Terminated.')}
          className="mt-3 rounded-xl bg-brand-charcoal px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-40">
          Terminate
        </button>
      </Card>
    </div>
  );
}
