import { useMemo, useState } from 'react';
import { manilaDay, shiftDay } from '@servdgo/shared';

export interface DayRange { from: string; to: string }

const today = manilaDay();

/** "1 Jul – 15 Jul 2026" — the span on screen, spelled out. */
export function rangeLabel(r: DayRange): string {
  const fmt = (d: string, withYear: boolean) => new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', {
    day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}),
  });
  if (r.from === r.to) return fmt(r.from, true);
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  return `${fmt(r.from, !sameYear)} – ${fmt(r.to, true)}`;
}

/**
 * The date filter every history screen shares.
 *
 * Presets for the question people usually have ("what happened this week?") and
 * a pair of date boxes for the one they occasionally have ("what happened on
 * the 3rd?"). Business days in Philippine time, so a range means the same thing
 * here as it does in the ledger and the earnings screen.
 */
export function useDayRange(defaultDays = 30, presets: number[] = [7, 30, 90]) {
  const [days, setDays] = useState(defaultDays);
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(() => shiftDay(today, -(defaultDays - 1)));
  const [to, setTo] = useState(today);

  const range = useMemo<DayRange>(() => (custom
    // Boxes filled in backwards are a slip, not a request for nothing.
    ? (from <= to ? { from, to } : { from: to, to: from })
    : { from: shiftDay(today, -(days - 1)), to: today }
  ), [custom, days, from, to]);

  const chip = (on: boolean) =>
    `rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition ${
      on ? 'bg-brand-green text-white ring-brand-green' : 'bg-white text-black/60 ring-black/10'}`;

  const controls = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {presets.map((r) => (
          <button key={r} onClick={() => { setDays(r); setCustom(false); }} className={chip(!custom && days === r)}>
            {r} days
          </button>
        ))}
        <button onClick={() => setCustom((v) => !v)} className={chip(custom)}>📅 Pick dates</button>
        <span className="text-xs text-black/40">{rangeLabel(range)}</span>
      </div>
      {custom && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl bg-black/[0.02] p-3 ring-1 ring-black/5">
          <label className="text-[11px] font-medium text-black/45">
            From
            <input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value || from)}
              className="mt-0.5 block rounded-lg border border-black/10 px-2 py-1.5 text-sm text-brand-ink" />
          </label>
          <label className="text-[11px] font-medium text-black/45">
            To
            <input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value || to)}
              className="mt-0.5 block rounded-lg border border-black/10 px-2 py-1.5 text-sm text-brand-ink" />
          </label>
          <span className="pb-1.5 text-xs text-black/40">Business days, Philippine time.</span>
        </div>
      )}
    </div>
  );

  return { range, controls, key: `${range.from}..${range.to}` };
}
