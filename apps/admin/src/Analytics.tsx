import { useEffect, useState } from 'react';
import { getAnalytics, analyticsRange, type Analytics as Data } from '@servdgo/supabase';
import type { DayRange, ServiceType } from '@servdgo/shared';
import type { DayCount as DayPoint } from '@servdgo/supabase';
import { errMessage, manilaDay, shiftDay } from '@servdgo/shared';
import { supabase } from './lib/supabase.ts';
import { Card, Muted, ErrorNote, Th, Td, peso } from './ui.tsx';

// Validated categorical palette (dataviz six-checks, light surface): fixed order.
const SERVICE_COLOR: Record<ServiceType, string> = {
  food: '#4A9415', pabili: '#7A4FB0', padala: '#C88A00',
};
const TREND = '#4A9415';

const RANGES = [7, 14, 30];
const today = manilaDay();

/** "1 Jul – 15 Jul 2026" — the span the figures cover, spelled out. */
function rangeLabel(r: DayRange): string {
  const fmt = (d: string, withYear: boolean) => new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', {
    day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}),
  });
  if (r.from === r.to) return fmt(r.from, true);
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  return `${fmt(r.from, !sameYear)} – ${fmt(r.to, true)}`;
}

function sample(spec: number | DayRange): Data {
  const range = analyticsRange(spec, today);
  const days = Math.max(1, Math.round(
    (new Date(`${range.to}T00:00:00Z`).getTime() - new Date(`${range.from}T00:00:00Z`).getTime()) / 86400000) + 1);
  const daily = Array.from({ length: days }, (_, i) => {
    const count = Math.round(4 + 5 * Math.abs(Math.sin(i / 2)));
    const delivered = Math.max(0, count - (i % 4 === 0 ? 1 : 0));
    return {
      day: shiftDay(range.from, i),
      count,
      delivered,
      gmv: Math.round(delivered * (280 + 40 * Math.abs(Math.cos(i / 3)))),
      commission: Math.round(delivered * (10 + 2 * Math.abs(Math.sin(i / 2))) * 100) / 100,
    };
  });
  return {
    rangeDays: days, range, totalOrders: 128, delivered: 112, cancelled: 6,
    gmv: 41850, commissionRevenue: 1284, convenienceRevenue: 560,
    byService: { food: 74, pabili: 33, padala: 21 },
    daily,
    riders: [
      { riderId: 'a', name: 'Ben Cruz', delivered: 41, commission: 486 },
      { riderId: 'b', name: 'Cy Ramos', delivered: 33, commission: 402 },
      { riderId: 'c', name: 'Dina Lim', delivered: 25, commission: 261 },
      { riderId: 'd', name: 'Ed Yu', delivered: 13, commission: 135 },
    ],
  };
}

export function Analytics() {
  const [days, setDays] = useState(14);
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(() => shiftDay(today, -13));
  const [to, setTo] = useState(today);
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  const spec: number | DayRange = custom ? { from, to } : days;
  const key = custom ? `${from}..${to}` : String(days);

  useEffect(() => {
    setD(null); setError(null);
    if (!supabase) { setD(sample(spec)); return; }
    getAnalytics(supabase, spec).then(setD).catch((e) => setError(errMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const chip = (on: boolean) =>
    `rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition ${
      on ? 'bg-brand-green text-white ring-brand-green' : 'bg-white text-black/60 ring-black/10'}`;

  const controls = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-black/50">Last</span>
        {RANGES.map((r) => (
          <button key={r} onClick={() => { setDays(r); setCustom(false); }} className={chip(!custom && days === r)}>
            {r} days
          </button>
        ))}
        <button onClick={() => setCustom((v) => !v)} className={chip(custom)}>📅 Pick dates</button>
        {d && <span className="text-xs text-black/40">{rangeLabel(d.range)}</span>}
      </div>
      {custom && (
        <div className="flex flex-wrap items-end gap-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-black/5">
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

  if (error) return <div className="space-y-5">{controls}<ErrorNote msg={error} /></div>;
  if (!d) return <div className="space-y-5">{controls}<Muted>Loading…</Muted></div>;

  return (
    <div className="space-y-5">
      {controls}

      {/* Hero figures */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile label="Commission revenue" value={peso(d.commissionRevenue)} accent />
        <Tile label="GMV" value={peso(d.gmv)} />
        <Tile label="Convenience fees (to riders)" value={peso(d.convenienceRevenue)} />
        <Tile label="Orders" value={`${d.totalOrders}`} sub={`${d.delivered} delivered · ${d.cancelled} cancelled`} />
      </div>

      <DailyTrend daily={d.daily} rangeDays={d.rangeDays} />

      <Card title="Orders by service">
        <ServiceBars byService={d.byService} />
      </Card>

      <Card title="Top riders by commission">
        {d.riders.length === 0 ? <p className="text-sm text-black/40">No delivered orders yet.</p>
          : <RiderBars riders={d.riders} />}
      </Card>
    </div>
  );
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl p-4 shadow-sm ring-1 ${accent ? 'bg-brand-green text-white ring-brand-green' : 'bg-white ring-black/5'}`}>
      <div className="text-2xl font-extrabold">{value}</div>
      <div className={`text-xs ${accent ? 'text-white/85' : 'text-black/50'}`}>{label}</div>
      {sub && <div className={`mt-0.5 text-[11px] ${accent ? 'text-white/75' : 'text-black/40'}`}>{sub}</div>}
    </div>
  );
}

/** Horizontal categorical bars with direct labels + legend (identity not color-alone). */
function ServiceBars({ byService }: { byService: Record<ServiceType, number> }) {
  const entries = (['food', 'pabili', 'padala'] as ServiceType[]).map((k) => ({ k, v: byService[k] }));
  const max = Math.max(1, ...entries.map((e) => e.v));
  return (
    <div className="space-y-3">
      {entries.map(({ k, v }) => (
        <div key={k} className="flex items-center gap-3">
          <span className="w-16 text-sm capitalize text-black/70">{k}</span>
          <div className="relative h-5 flex-1 rounded bg-black/[0.04]">
            <div className="absolute inset-y-0 left-0 rounded" style={{ width: `${(v / max) * 100}%`, background: SERVICE_COLOR[k] }} />
          </div>
          <span className="w-8 text-right text-sm font-semibold tabular-nums">{v}</span>
        </div>
      ))}
      <div className="flex gap-4 pt-1 text-xs text-black/50">
        {entries.map(({ k }) => (
          <span key={k} className="flex items-center gap-1.5 capitalize">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERVICE_COLOR[k] }} />{k}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The three things an operator watches, each on its own scale. */
const METRICS = [
  { key: 'count' as const, label: 'Orders', money: false, blurb: 'every order placed that day' },
  { key: 'gmv' as const, label: 'GMV', money: true, blurb: 'goods + fees, cancelled orders excluded' },
  { key: 'commission' as const, label: 'Commission', money: true, blurb: 'your cut of delivered orders' },
];
type MetricKey = (typeof METRICS)[number]['key'];

/** "5 Aug" — compact enough to repeat along an axis. */
const dayTick = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', { day: 'numeric', month: 'short' });
const dayFull = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * A top-of-axis a person would have chosen, divisible by the four gaps between
 * the five gridlines — so the labels read 0/2/4/6/8, never 0/2/5/7/9.
 */
function niceMax(v: number, integer = false): number {
  if (v <= 0) return 4;
  const rough = v / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  // An order count has no half — 2.5 orders is not a gridline anyone wants.
  const steps = integer && mag < 1 ? [1] : integer ? [1, 2, 3, 4, 5, 6, 8, 10] : [1, 2, 2.5, 5, 10];
  const step = steps.map((m) => m * (integer && mag < 1 ? 1 : mag)).find((c) => c >= rough) ?? 10 * mag;
  return step * 4;
}

/** ₱28,878.00 — grouped, because an unbroken run of digits is unreadable. */
const money = (n: number) =>
  `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Daily history, one measure at a time.
 *
 * Orders, GMV and commission live on wildly different scales — a day is 9
 * orders, ₱2,800 of GMV and ₱180 of commission — so they get a switch rather
 * than a shared axis. Two y-scales on one chart is the fastest way to make a
 * flat month look like a boom.
 *
 * The span comes from the filter above; every day in it is plotted, so a quiet
 * Tuesday reads as a zero rather than a gap the line hops over.
 */
function DailyTrend({ daily, rangeDays }: { daily: DayPoint[]; rangeDays: number }) {
  const [metric, setMetric] = useState<MetricKey>('count');
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const spec = METRICS.find((m) => m.key === metric)!;

  const W = 960, H = 260, padL = 56, padR = 16, padT = 16, padB = 34;
  const values = daily.map((d) => d[metric]);
  const max = niceMax(Math.max(...values, 0), !spec.money);
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  // A single day has no line to draw, so it sits in the middle of the plot.
  const x = (i: number) => (daily.length < 2 ? padL + plotW / 2 : padL + (plotW * i) / (daily.length - 1));
  const y = (v: number) => padT + plotH - (plotH * v) / max;

  const fmt = (v: number) => (spec.money ? money(v) : v.toLocaleString('en-PH'));
  const line = daily.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d[metric]).toFixed(1)}`).join(' ');
  const area = `${line} L${x(daily.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${x(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
  const gridAt = [0, 0.25, 0.5, 0.75, 1];
  // Roughly six labels however long the span is, always including the last day.
  const tickEvery = Math.max(1, Math.ceil(daily.length / 6));
  const total = values.reduce((n, v) => n + v, 0);
  const busiest = daily.reduce((best, d) => (d[metric] > best[metric] ? d : best), daily[0]!);

  const chip = (on: boolean) =>
    `rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition ${
      on ? 'bg-brand-green text-white ring-brand-green' : 'bg-white text-black/60 ring-black/10'}`;

  return (
    <Card
      title={`${spec.label} per day · ${rangeDays} day${rangeDays === 1 ? '' : 's'}`}
      action={
        <span className="flex flex-wrap gap-2">
          {METRICS.map((m) => (
            <button key={m.key} onClick={() => { setMetric(m.key); setHover(null); }} className={chip(metric === m.key)}>
              {m.label}
            </button>
          ))}
          <button onClick={() => setAsTable((v) => !v)} className={chip(asTable)}>
            {asTable ? '📈 Chart' : '▦ Table'}
          </button>
        </span>
      }
    >
      <p className="-mt-1 mb-3 text-xs text-black/45">
        {spec.blurb} · {fmt(spec.money ? Math.round(total * 100) / 100 : total)} over the span
        {busiest && busiest[metric] > 0 && <> · busiest {dayFull(busiest.day)} at {fmt(busiest[metric])}</>}
      </p>

      {asTable ? (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-left text-black/50">
              <tr className="border-b border-black/5">
                <Th>Day</Th><Th>Orders</Th><Th>Delivered</Th><Th>GMV</Th><Th>Commission</Th>
              </tr>
            </thead>
            <tbody>
              {[...daily].reverse().map((p) => (
                <tr key={p.day} className="border-b border-black/[0.04]">
                  <Td className="whitespace-nowrap text-black/60">{dayFull(p.day)}</Td>
                  <Td className="tabular-nums">{p.count}</Td>
                  <Td className="tabular-nums text-black/60">{p.delivered}</Td>
                  <Td className="tabular-nums">{money(p.gmv)}</Td>
                  <Td className="font-medium tabular-nums">{money(p.commission)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
            aria-label={`${spec.label} per day from ${daily[0]?.day} to ${daily[daily.length - 1]?.day}`}
            onMouseLeave={() => setHover(null)}>
            <defs>
              <linearGradient id="ebd-trend-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={TREND} stopOpacity="0.22" />
                <stop offset="100%" stopColor={TREND} stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {gridAt.map((g) => (
              <g key={g}>
                <line x1={padL} x2={W - padR} y1={y(max * g)} y2={y(max * g)} stroke="#0000000f" />
                <text x={padL - 8} y={y(max * g) + 3.5} fontSize={10} fill="#00000066" textAnchor="end">
                  {spec.money ? `₱${Math.round(max * g).toLocaleString('en-PH')}` : Math.round(max * g).toLocaleString('en-PH')}
                </text>
              </g>
            ))}

            <path d={area} fill="url(#ebd-trend-fill)" />
            <path d={line} fill="none" stroke={TREND} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

            {daily.map((p, i) => {
              const last = i === daily.length - 1;
              if (!(i % tickEvery === 0 || last)) return null;
              // The final label would otherwise hang off the right edge.
              return (
                <text key={p.day} x={x(i)} y={H - 12} fontSize={10} fill="#00000066"
                  textAnchor={last ? 'end' : i === 0 ? 'start' : 'middle'}>
                  {dayTick(p.day)}
                </text>
              );
            })}

            {hover != null && daily[hover] && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} stroke="#00000026" strokeDasharray="3 3" />
                {/* 2px surface ring so the marker reads against the fill. */}
                <circle cx={x(hover)} cy={y(daily[hover]![metric])} r={5.5} fill={TREND} stroke="#fff" strokeWidth={2} />
              </g>
            )}

            {/* Hit targets wider than the marks, so hovering is not a game of skill. */}
            {daily.map((p, i) => (
              <rect key={p.day} x={x(i) - Math.max(6, plotW / daily.length / 2)} y={padT}
                width={Math.max(12, plotW / daily.length)} height={plotH}
                fill="transparent" onMouseEnter={() => setHover(i)} />
            ))}
          </svg>

          {/* Anchored to the side the cursor is not on, so it never hides the
              point it is describing. */}
          {hover != null && daily[hover] && (
            <div className={`pointer-events-none absolute top-1 rounded-lg bg-brand-ink/92 px-2.5 py-1.5 text-[11px] text-white shadow-lg ${
              hover < daily.length / 2 ? 'right-2' : 'left-2'}`}>
              <span className="block font-semibold">{dayFull(daily[hover]!.day)}</span>
              <span className="block text-white/85">{spec.label}: {fmt(daily[hover]![metric])}</span>
              <span className="block text-white/60">{daily[hover]!.delivered} delivered of {daily[hover]!.count}</span>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function RiderBars({ riders }: { riders: { name: string; delivered: number; commission: number }[] }) {
  const max = Math.max(1, ...riders.map((r) => r.commission));
  return (
    <div className="space-y-3">
      {riders.map((r, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="w-28 truncate text-sm text-black/70">{r.name}</span>
          <div className="relative h-5 flex-1 rounded bg-black/[0.04]">
            <div className="absolute inset-y-0 left-0 rounded bg-brand-green" style={{ width: `${(r.commission / max) * 100}%` }} />
          </div>
          <span className="w-20 text-right text-sm font-semibold tabular-nums">{peso(r.commission)}</span>
          <span className="w-16 text-right text-xs text-black/40">{r.delivered} trips</span>
        </div>
      ))}
    </div>
  );
}
