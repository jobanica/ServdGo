/**
 * How each city is running, and what is worth waking up for.
 *
 * The scorecard is a materialised view refreshed on a schedule, so it carries
 * `refreshed_at` — show it. A number that looks live and is forty minutes old is
 * worse than one that admits its age.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ScorecardRow {
  territory_id: string;
  territory_name: string;
  window_days: 7 | 30;
  orders: number;
  delivered: number;
  cancelled: number;
  mins_to_assign: number | null;
  mins_to_pickup: number | null;
  mins_to_deliver: number | null;
  completion_pct: number | null;
  cancelled_pct: number | null;
  decline_pct: number | null;
  unremitted_cod: number;
  pending_remittances: number;
  variance_remittances: number;
  refreshed_at: string;
}

export interface Thresholds {
  territory_id: string | null;
  max_mins_to_assign: number;
  max_mins_to_deliver: number;
  min_completion_pct: number;
  max_cancelled_pct: number;
  max_decline_pct: number;
}

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  id: number;
  territory_id: string | null;
  kind: string;
  severity: AlertSeverity;
  title: string;
  detail: string | null;
  entity: string | null;
  entity_id: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  created_at: string;
}

export async function listScorecard(
  db: SupabaseClient, windowDays: 7 | 30 = 7,
): Promise<ScorecardRow[]> {
  const { data, error } = await db
    .from('territory_scorecard')
    .select('territory_id, territory_name, window_days, orders, delivered, cancelled, mins_to_assign, mins_to_pickup, mins_to_deliver, completion_pct, cancelled_pct, decline_pct, unremitted_cod, pending_remittances, variance_remittances, refreshed_at')
    .eq('window_days', windowDays)
    .order('territory_name');
  if (error) throw error;
  return (data ?? []) as ScorecardRow[];
}

/** Which thresholds a city is currently breaching, as readable phrases. */
export async function scorecardBreaches(
  db: SupabaseClient, territoryId: string,
): Promise<string[]> {
  const { data, error } = await db.rpc('scorecard_breaches', { p_territory: territoryId });
  if (error) throw error;
  return (data ?? []) as string[];
}

export async function listThresholds(db: SupabaseClient): Promise<Thresholds[]> {
  const { data, error } = await db
    .from('scorecard_thresholds')
    .select('territory_id, max_mins_to_assign, max_mins_to_deliver, min_completion_pct, max_cancelled_pct, max_decline_pct');
  if (error) throw error;
  return (data ?? []) as Thresholds[];
}

/** Rebuild the scorecard now rather than waiting for the next quarter hour. */
export async function refreshScorecard(db: SupabaseClient): Promise<void> {
  const { error } = await db.rpc('refresh_scorecard');
  if (error) throw error;
}

export async function listAlerts(
  db: SupabaseClient, opts: { openOnly?: boolean; territoryId?: string } = {},
): Promise<Alert[]> {
  let q = db
    .from('alerts')
    .select('id, territory_id, kind, severity, title, detail, entity, entity_id, acknowledged_by, acknowledged_at, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (opts.openOnly !== false) q = q.is('acknowledged_at', null);
  if (opts.territoryId) q = q.eq('territory_id', opts.territoryId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Alert[];
}

export async function acknowledgeAlert(db: SupabaseClient, id: number): Promise<void> {
  const { error } = await db.rpc('acknowledge_alert', { p_id: id });
  if (error) throw error;
}

/**
 * Run the generators now.
 *
 * They run every quarter hour anyway; the button is for after a change, so the
 * effect is visible rather than something that appears later. Deduped, so
 * running it does not create noise.
 */
export async function generateAlerts(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc('generate_alerts');
  if (error) throw error;
  return Number(data ?? 0);
}
