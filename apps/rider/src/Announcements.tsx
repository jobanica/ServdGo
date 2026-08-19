/**
 * Notices from HQ, in the rider app.
 *
 * Dismissing is per rider — the read is recorded against their own profile —
 * so one rider clearing a notice does not clear it for the next.
 */
import { useEffect, useState } from 'react';
import {
  unreadAnnouncements, markAnnouncementRead, type Announcement,
} from '@servdgo/supabase';
import { supabase } from './lib/supabase.ts';

const TONE: Record<Announcement['severity'], string> = {
  critical: 'bg-brand-orange/20 ring-brand-orange text-brand-orange',
  warning: 'bg-brand-yellow/20 ring-brand-yellow text-yellow-900',
  info: 'bg-black/[0.04] ring-black/10 text-black/70',
};

export function AnnouncementBanner() {
  const [rows, setRows] = useState<Announcement[]>([]);

  useEffect(() => {
    if (!supabase) return;
    void unreadAnnouncements(supabase).then(setRows).catch(() => setRows([]));
  }, []);

  if (rows.length === 0) return null;

  async function dismiss(id: number) {
    if (supabase) await markAnnouncementRead(supabase, id).catch(() => {});
    setRows((r) => r.filter((a) => a.id !== id));
  }

  return (
    <div className="mb-4 space-y-2">
      {rows.map((a) => (
        <div key={a.id} className={`rounded-2xl p-4 ring-1 ${TONE[a.severity]}`} role="status">
          <p className="text-sm font-bold">{a.title}</p>
          <p className="mt-1 text-sm opacity-85">{a.body}</p>
          <button onClick={() => void dismiss(a.id)}
            className="mt-2 rounded-lg bg-white/60 px-2 py-1 text-xs font-semibold">
            Got it
          </button>
        </div>
      ))}
    </div>
  );
}
