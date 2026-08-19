/**
 * A city's records as a spreadsheet.
 *
 * The rows are turned into CSV by the database — the same function the
 * hq-export endpoint streams — so an export from here and an export from a
 * script agree on quoting, on timezone, and on who is allowed to see what.
 */
import { useState } from 'react';
import { exportCsv, type ExportDataset, type Territory } from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { Card, ErrorNote } from '../ui.tsx';

const SETS: { key: ExportDataset; label: string; hint: string }[] = [
  { key: 'deliveries', label: 'Deliveries', hint: 'Every order, its fees and who carried it' },
  { key: 'commissions', label: 'Rider commission', hint: 'What each rider owed, day by day' },
  { key: 'remittances', label: 'Remittances', hint: 'What riders paid in, and whether it cleared' },
  { key: 'royalty', label: 'Royalty', hint: 'What this city owes HQ, entry by entry' },
  { key: 'invoices', label: 'Invoices', hint: 'What HQ billed, and what came back' },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function Export({ territory }: { territory: Territory }) {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const [busy, setBusy] = useState<ExportDataset | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(dataset: ExportDataset) {
    if (!supabase) return;
    setBusy(dataset); setError(null);
    try {
      const csv = await exportCsv(supabase, dataset, territory.id, from, to);
      // A BOM so a peso sign survives being opened in Excel.
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `servdgo-${territory.slug}-${dataset}-${from}_${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(errMessage(e)); }
    finally { setBusy(null); }
  }

  if (!isSupabaseConfigured) return null;

  return (
    <Card title="Export">
      {error && <div className="mb-3"><ErrorNote msg={error} /></div>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-black/40">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="mt-1 block rounded-lg border border-black/10 px-3 py-2 text-sm" />
        </label>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-black/40">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="mt-1 block rounded-lg border border-black/10 px-3 py-2 text-sm" />
        </label>
      </div>

      <ul className="mt-4 divide-y divide-black/5">
        {SETS.map((s) => (
          <li key={s.key} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{s.label}</p>
              <p className="text-xs text-black/50">{s.hint}</p>
            </div>
            <button onClick={() => void download(s.key)} disabled={busy !== null}
              className="rounded-xl px-3 py-2 text-sm font-semibold ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-40">
              {busy === s.key ? 'Building…' : 'Download CSV'}
            </button>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs text-black/45">
        Times are in {territory.name}'s own timezone. A year of deliveries is a large file —
        it is built by the database, not the browser.
      </p>
    </Card>
  );
}
