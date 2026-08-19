/**
 * Notices from HQ, and who they are addressed to.
 *
 * An announcement with no city goes to every city; an audience decides which
 * app shows it. Recipients dismiss their own copy, so "unread" is per person
 * rather than a global flag somebody clears for everybody.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  listAnnouncements, publishAnnouncement, deleteAnnouncement, listTerritories,
  unreadAnnouncements, markAnnouncementRead,
  type Announcement, type AnnouncementAudience, type Territory,
} from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { Card, Muted, ErrorNote } from '../ui.tsx';

const AUDIENCES: { key: AnnouncementAudience; label: string }[] = [
  { key: 'operators', label: 'Operators' },
  { key: 'riders', label: 'Riders' },
  { key: 'merchants', label: 'Partner restaurants' },
  { key: 'customers', label: 'Customers' },
  { key: 'everyone', label: 'Everyone' },
];

const TONE: Record<Announcement['severity'], string> = {
  critical: 'bg-brand-orange/20 text-brand-orange',
  warning: 'bg-brand-yellow/30 text-yellow-800',
  info: 'bg-black/5 text-black/60',
};

export function Announcements() {
  const [rows, setRows] = useState<Announcement[]>([]);
  const [cities, setCities] = useState<Territory[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<AnnouncementAudience>('operators');
  const [territoryId, setTerritoryId] = useState('');
  const [severity, setSeverity] = useState<Announcement['severity']>('info');
  const [endsAt, setEndsAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    setError(null);
    try {
      const [a, t] = await Promise.all([listAnnouncements(supabase), listTerritories(supabase)]);
      setRows(a); setCities(t);
    } catch (e) { setError(errMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function publish() {
    if (!supabase) return;
    setBusy(true); setError(null);
    try {
      await publishAnnouncement(supabase, {
        title, body, audience,
        territoryId: territoryId || null,
        severity,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      });
      setTitle(''); setBody(''); setEndsAt('');
      await load();
    } catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  if (!isSupabaseConfigured) return <Muted>Connect Supabase to publish announcements.</Muted>;

  const cityName = (id: string | null) =>
    id ? (cities.find((c) => c.id === id)?.name ?? 'one city') : 'Every city';

  return (
    <div className="space-y-5">
      {error && <ErrorNote msg={error} />}

      <Card title="New announcement">
        <div className="space-y-3">
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Title" className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3}
            placeholder="What you want them to know"
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-black/40">Audience</span>
              <select value={audience} onChange={(e) => setAudience(e.target.value as AnnouncementAudience)}
                className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm">
                {AUDIENCES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-black/40">City</span>
              <select value={territoryId} onChange={(e) => setTerritoryId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm">
                <option value="">Every city</option>
                {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-black/40">Severity</span>
              <select value={severity}
                onChange={(e) => setSeverity(e.target.value as Announcement['severity'])}
                className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm">
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-black/40">Stop showing</span>
              <input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)}
                className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
            </label>
          </div>
          <button onClick={() => void publish()}
            disabled={busy || !title.trim() || !body.trim()}
            className="rounded-xl bg-brand-orange px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </Card>

      <Card title="Published">
        {rows.length === 0 ? <p className="text-sm text-black/50">Nothing published yet.</p> : (
          <ul className="divide-y divide-black/5">
            {rows.map((a) => {
              const over = a.ends_at && new Date(a.ends_at) < new Date();
              return (
                <li key={a.id} className="flex flex-wrap items-start gap-3 py-3">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[a.severity]}`}>
                    {a.severity}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{a.title}</p>
                    <p className="text-sm text-black/60">{a.body}</p>
                    <p className="mt-1 text-xs text-black/40">
                      {AUDIENCES.find((x) => x.key === a.audience)?.label ?? a.audience}
                      {' · '}{cityName(a.territory_id)}
                      {' · '}{new Date(a.starts_at).toLocaleString()}
                      {over && ' · expired'}
                    </p>
                  </div>
                  <button onClick={() => void deleteAnnouncement(supabase!, a.id).then(load)}
                    className="rounded-lg px-2 py-1 text-xs font-semibold text-black/50 hover:bg-black/5">
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * The banner in the operator console. Dismissing is per person, so one
 * operator clearing it does not clear it for the next.
 */
export function AnnouncementBanner() {
  const [rows, setRows] = useState<Announcement[]>([]);

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) return;
    void unreadAnnouncements(supabase)
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  if (rows.length === 0) return null;

  async function dismiss(id: number) {
    await markAnnouncementRead(supabase!, id).catch(() => {});
    setRows((r) => r.filter((a) => a.id !== id));
  }

  return (
    <div className="mb-4 space-y-2">
      {rows.map((a) => (
        <div key={a.id}
          className={`flex flex-wrap items-start gap-2 rounded-xl px-3 py-2 text-sm ${TONE[a.severity]}`}>
          <div className="min-w-0 flex-1">
            <span className="font-bold">{a.title}</span>
            <span className="ml-2 opacity-80">{a.body}</span>
          </div>
          <button onClick={() => void dismiss(a.id)}
            className="rounded-lg bg-white/50 px-2 py-0.5 text-xs font-semibold">
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
