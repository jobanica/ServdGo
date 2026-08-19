/**
 * The franchisor's share, and how a city pays it.
 *
 * Two sides of one ledger. An operator sees what they owe and declares a
 * payment; the franchisor sees every city and is the only one who can confirm
 * that a payment arrived. Both are enforced in the database — these functions
 * will throw rather than quietly do nothing if called by the wrong person.
 *
 * Nothing is owed until a rider's settlement is confirmed. A royalty is booked
 * off the commission-ledger row becoming settled, so it always follows money
 * that actually arrived.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type RoyaltyKind = 'royalty' | 'joining_fee' | 'adjustment';

export interface RoyaltyEntry {
  id: string;
  territory_id: string;
  kind: RoyaltyKind;
  base_amount: number;
  rate: number;
  amount: number;
  business_day: string;
  settled: boolean;
  note: string | null;
  created_at: string;
}

export interface OperatorSettlement {
  id: string;
  territory_id: string;
  period_start: string;
  period_end: string;
  amount_due: number;
  amount_settled: number | null;
  method: string | null;
  reference: string | null;
  receipt_url: string | null;
  status: 'pending' | 'confirmed';
  confirmed_at: string | null;
  created_at: string;
}

/** One row per city: what it did, what it earned, what it owes. */
export interface FranchisorRow {
  territory_id: string;
  territory_name: string;
  status: 'draft' | 'active' | 'suspended';
  operator_name: string | null;
  commission_rate: number;
  orders_delivered: number;
  platform_revenue: number;
  royalty_booked: number;
  royalty_settled: number;
  royalty_due: number;
  royalty_overdue: number;
  last_settled_at: string | null;
}

/** Every city, over a window. Franchisor only — throws for anyone else. */
export async function franchisorOverview(
  db: SupabaseClient, from: string, to: string,
): Promise<FranchisorRow[]> {
  const { data, error } = await db.rpc('franchisor_overview', { p_from: from, p_to: to });
  if (error) throw error;
  return (data ?? []) as FranchisorRow[];
}

/** What one city owes, readable by that city's own operator. */
export async function territoryRoyaltySummary(
  db: SupabaseClient, territoryId: string, from: string, to: string,
): Promise<{
  territoryName: string; rate: number; cycle: 'weekly' | 'monthly';
  platformRevenue: number; royaltyBooked: number; royaltyDue: number;
  royaltyOverdue: number; operatorKeeps: number;
}> {
  const { data, error } = await db.rpc('territory_royalty_summary', {
    p_territory: territoryId, p_from: from, p_to: to,
  });
  if (error) throw error;
  const s = (data ?? {}) as Record<string, unknown>;
  return {
    territoryName: String(s.territoryName ?? ''),
    rate: Number(s.rate ?? 0),
    cycle: (s.cycle as 'weekly' | 'monthly') ?? 'monthly',
    platformRevenue: Number(s.platformRevenue ?? 0),
    royaltyBooked: Number(s.royaltyBooked ?? 0),
    royaltyDue: Number(s.royaltyDue ?? 0),
    royaltyOverdue: Number(s.royaltyOverdue ?? 0),
    operatorKeeps: Number(s.operatorKeeps ?? 0),
  };
}

/** The period the franchisor's cycle puts a date in. */
export async function royaltyPeriod(
  db: SupabaseClient, day: string,
): Promise<{ period_start: string; period_end: string }> {
  const { data, error } = await db.rpc('royalty_period', { p_day: day });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as
    { period_start: string; period_end: string } | undefined;
  if (!row) throw new Error('no royalty period configured');
  return row;
}

/** A city's royalty entries, newest first. */
export async function listRoyaltyEntries(
  db: SupabaseClient, territoryId?: string, limit = 200,
): Promise<RoyaltyEntry[]> {
  let q = db
    .from('royalty_ledger')
    .select('id, territory_id, kind, base_amount, rate, amount, business_day, settled, note, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (territoryId) q = q.eq('territory_id', territoryId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as RoyaltyEntry[];
}

export async function listOperatorSettlements(
  db: SupabaseClient, territoryId?: string,
): Promise<OperatorSettlement[]> {
  let q = db
    .from('operator_settlements')
    .select('id, territory_id, period_start, period_end, amount_due, amount_settled, method, reference, receipt_url, status, confirmed_at, created_at')
    .order('period_end', { ascending: false });
  if (territoryId) q = q.eq('territory_id', territoryId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as OperatorSettlement[];
}

/**
 * The operator declares a payment for a period.
 *
 * The amount is computed in the database from what is actually outstanding, not
 * taken from the caller — so this returns the settlement id, and you read the
 * amount back off it.
 */
export async function submitRoyaltySettlement(
  db: SupabaseClient,
  params: { periodStart: string; periodEnd: string; method?: string; reference?: string; receiptUrl?: string },
): Promise<string> {
  const { data, error } = await db.rpc('operator_submit_royalty_settlement', {
    p_period_start: params.periodStart,
    p_period_end: params.periodEnd,
    p_method: params.method ?? null,
    p_reference: params.reference ?? null,
    p_receipt_url: params.receiptUrl ?? null,
  });
  if (error) throw error;
  return data as string;
}

/** Franchisor only. Returns the amount the confirmation actually cleared. */
export async function confirmRoyaltySettlement(
  db: SupabaseClient, settlementId: string,
): Promise<number> {
  const { data, error } = await db.rpc('franchisor_confirm_royalty_settlement', {
    p_settlement: settlementId,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/** Franchisor only: a one-off charge or credit against a city. */
export async function chargeTerritoryFee(
  db: SupabaseClient,
  params: { territoryId: string; amount: number; kind?: 'joining_fee' | 'adjustment'; note?: string },
): Promise<string> {
  const { data, error } = await db.rpc('charge_territory_fee', {
    p_territory: params.territoryId,
    p_amount: params.amount,
    p_kind: params.kind ?? 'joining_fee',
    p_note: params.note ?? null,
  });
  if (error) throw error;
  return data as string;
}

/** Franchisor only: appoint an operator and bind them to the city in one step. */
export async function appointOperator(
  db: SupabaseClient, territoryId: string, profileId: string,
): Promise<void> {
  const { error } = await db.rpc('assign_territory_operator', {
    p_territory: territoryId, p_profile: profileId,
  });
  if (error) throw error;
}

/**
 * Franchisor only: open a city for business.
 *
 * Refuses a city with no operator, no boundary or no payout details — each of
 * those is only discoverable once real orders are running.
 */
export async function approveTerritory(db: SupabaseClient, territoryId: string): Promise<void> {
  const { error } = await db.rpc('approve_territory', { p_territory: territoryId });
  if (error) throw error;
}

/** Franchisor only. Stops new orders; history and open orders are untouched. */
export async function suspendTerritory(
  db: SupabaseClient, territoryId: string, reason?: string,
): Promise<void> {
  const { error } = await db.rpc('suspend_territory', {
    p_territory: territoryId, p_reason: reason ?? null,
  });
  if (error) throw error;
}
