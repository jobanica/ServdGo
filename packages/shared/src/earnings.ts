/**
 * What a rider actually took home, by day.
 *
 * The commission ledger answers "what do I owe the operator?"; this answers the
 * question riders ask first — "how much did I make today?". One record per
 * delivered order, keyed to the Philippine business day it was completed on, so
 * the totals line up with the settlement gate's idea of a day.
 */

import { roundPeso } from './money.ts';
import { riderEarnings } from './pricing.ts';
import type { ServiceType } from './types.ts';

/** One delivered order, from the rider's pay-slip point of view. */
export interface EarningRecord {
  orderId: string;
  /** Philippine business day the delivery completed on (YYYY-MM-DD). */
  businessDay: string;
  serviceType: ServiceType;
  deliveryFee: number;
  storeFeeTotal: number;
  convenienceFee: number;
  /** Operator commission booked against this order. */
  commission: number;
}

/** An inclusive span of business days. */
export interface DayRange {
  from: string;
  to: string;
}

/** Take-home for a single delivery: the fees collected, less commission. */
export function recordEarnings(r: EarningRecord): number {
  return riderEarnings({
    deliveryFee: r.deliveryFee,
    storeFeeTotal: r.storeFeeTotal,
    convenienceFee: r.convenienceFee,
    commission: r.commission,
  });
}

/** Today in Manila as YYYY-MM-DD — the business day the ledger books against. */
export function manilaDay(at: Date = new Date()): string {
  return at.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

/** Shift a YYYY-MM-DD day by whole days (negative goes back). */
export function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The presets offered above the calendar in the rider's earnings view. */
export type RangePreset = 'today' | 'week' | 'month' | 'all';

export const RANGE_LABELS: Record<RangePreset, string> = {
  today: 'Today',
  week: 'Last 7 days',
  month: 'This month',
  all: 'All time',
};

/**
 * Resolve a preset against a business day. `all` starts at the epoch so the
 * same inclusive from/to filter works for every preset.
 *
 * @example
 * presetRange('week', '2026-08-04') // { from: '2026-07-29', to: '2026-08-04' }
 */
export function presetRange(preset: RangePreset, today: string = manilaDay()): DayRange {
  switch (preset) {
    case 'today': return { from: today, to: today };
    case 'week': return { from: shiftDay(today, -6), to: today };
    case 'month': return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'all': return { from: '1970-01-01', to: today };
  }
}

/** Records falling inside the range (both ends inclusive). */
export function filterEarnings(records: readonly EarningRecord[], range: DayRange): EarningRecord[] {
  const { from, to } = normalizeRange(range);
  return records.filter((r) => r.businessDay >= from && r.businessDay <= to);
}

/** A back-to-front range (from after to) is read as the span between them. */
export function normalizeRange(range: DayRange): DayRange {
  return range.from <= range.to ? range : { from: range.to, to: range.from };
}

/** One day's line in the earnings breakdown. */
export interface DayEarnings {
  day: string;
  deliveries: number;
  /** Take-home for the day (fees collected, less commission). */
  earned: number;
  commission: number;
}

export interface EarningsSummary {
  /** Total take-home across the range. */
  earned: number;
  /** Commission booked across the range (owed or already settled). */
  commission: number;
  /** Fees collected before commission. */
  gross: number;
  deliveries: number;
  /** Per-day totals, most recent day first. */
  byDay: DayEarnings[];
  /** Average take-home per delivery, 0 when there were none. */
  perDelivery: number;
}

/** Roll a set of records up into range and per-day totals. */
export function summarizeEarnings(records: readonly EarningRecord[]): EarningsSummary {
  const days = new Map<string, DayEarnings>();
  let earned = 0;
  let commissionTotal = 0;

  for (const r of records) {
    const take = recordEarnings(r);
    earned += take;
    commissionTotal += r.commission;
    const row = days.get(r.businessDay) ?? { day: r.businessDay, deliveries: 0, earned: 0, commission: 0 };
    row.deliveries += 1;
    row.earned = roundPeso(row.earned + take);
    row.commission = roundPeso(row.commission + r.commission);
    days.set(r.businessDay, row);
  }

  const total = roundPeso(earned);
  const commission = roundPeso(commissionTotal);
  return {
    earned: total,
    commission,
    gross: roundPeso(total + commission),
    deliveries: records.length,
    byDay: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
    perDelivery: records.length ? roundPeso(total / records.length) : 0,
  };
}
