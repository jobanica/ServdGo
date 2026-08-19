/**
 * HQ-issued invoicing: what each city has been billed, what is late, and what
 * happens when it stays late.
 *
 * The amounts are computed in Postgres from the royalty ledger — nothing here
 * decides what a city owes. Issuing is idempotent per period, so re-running a
 * month is safe and refreshes the figure rather than billing twice.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type AgingBucket = 'current' | '1-15' | '16-30' | '30+' | 'paid';

export interface InvoiceRow {
  id: string;
  territory_id: string;
  territory_name: string;
  period_start: string;
  period_end: string;
  due_at: string | null;
  amount_due: number;
  franchise_fee: number;
  royalty_amount: number;
  status: 'pending' | 'confirmed';
  days_overdue: number;
  bucket: AgingBucket;
}

export const AGING_ORDER: AgingBucket[] = ['current', '1-15', '16-30', '30+', 'paid'];
export const AGING_LABEL: Record<AgingBucket, string> = {
  current: 'Current', '1-15': '1–15 days', '16-30': '16–30 days',
  '30+': 'Over 30 days', paid: 'Paid',
};

/** Every invoice with its aging bucket, newest period first. */
export async function listInvoiceAging(db: SupabaseClient): Promise<InvoiceRow[]> {
  const { data, error } = await db
    .from('invoice_aging')
    .select('id, territory_id, territory_name, period_start, period_end, due_at, amount_due, franchise_fee, royalty_amount, status, days_overdue, bucket')
    .order('period_end', { ascending: false });
  if (error) throw error;
  return (data ?? []) as InvoiceRow[];
}

/**
 * Issue this period's invoices for every live city.
 *
 * Normally the monthly cron does this; the button exists for the first run, and
 * for re-issuing after a late royalty entry lands. Returns how many were raised
 * or refreshed — a city with nothing outstanding is skipped, not billed zero.
 */
export async function runMonthlyInvoicing(
  db: SupabaseClient, day?: string,
): Promise<number> {
  const { data, error } = await db.rpc('run_monthly_invoicing', { p_day: day ?? null });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function generateInvoice(
  db: SupabaseClient, territoryId: string, periodStart: string, periodEnd: string,
): Promise<string | null> {
  const { data, error } = await db.rpc('generate_invoice', {
    p_territory: territoryId, p_period_start: periodStart, p_period_end: periodEnd,
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

/** What a city owes that is genuinely late — anything still in grace is excluded. */
export async function territoryOverdue(db: SupabaseClient, territoryId: string): Promise<number> {
  const { data, error } = await db.rpc('territory_overdue_invoices', { p_territory: territoryId });
  if (error) throw error;
  return Number(data ?? 0);
}

/**
 * Suspend every live city with an overdue invoice.
 *
 * Runs nightly on its own; exposed so it can be run on demand, and so the
 * effect is visible rather than mysterious. Only ever suspends — reopening is
 * `reactivateIfPaidUp`, and neither touches a suspension somebody chose.
 */
export async function sweepOverdue(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc('sweep_overdue_territories');
  if (error) throw error;
  return Number(data ?? 0);
}

/** Lift an automatic suspension once nothing is overdue. Returns whether it did. */
export async function reactivateIfPaidUp(
  db: SupabaseClient, territoryId: string,
): Promise<boolean> {
  const { data, error } = await db.rpc('reactivate_if_paid_up', { p_territory: territoryId });
  if (error) throw error;
  return Boolean(data);
}
