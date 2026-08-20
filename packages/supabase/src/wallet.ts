/**
 * The rider wallet, and the money it moves.
 *
 * A rider prepays; every delivery deducts its commission the moment it is
 * booked. That single change re-points the whole franchise: the franchisor
 * holds the float, keeps its royalty out of it, and owes each city the rest at
 * the end of the day.
 *
 * So there are three readers here and they are deliberately separate — the
 * rider's own wallet, the city office's roll-call of the wallets it is
 * responsible for, and the franchisor's daily payout record. Each one is a
 * database function that decides for itself who may call it; nothing below
 * filters by hand.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type WalletEntryKind = 'topup' | 'commission' | 'markup' | 'adjustment' | 'refund';
export type TopupChannel = 'xendit' | 'cash' | 'bank' | 'grant';
export type TopupStatus = 'pending' | 'paid' | 'expired' | 'failed' | 'cancelled';

export interface WalletSummary {
  riderId: string;
  riderName: string;
  territoryId: string | null;
  /** What is in the wallet right now. Negative means the rider is behind. */
  balance: number;
  /** What it held at the end of yesterday — the number the lock reads. */
  balanceYesterday: number;
  overdue: number;
  locked: boolean;
  low: boolean;
  walletEnabled: boolean;
  minTopup: number;
  maxTopup: number;
  creditLimit: number;
  lastTopupAt: string | null;
  chargedToday: number;
}

export interface WalletEntry {
  id: string;
  createdAt: string;
  businessDay: string;
  kind: WalletEntryKind;
  amount: number;
  balanceAfter: number;
  note: string | null;
  orderId: string | null;
  topupId: string | null;
}

export interface WalletTopup {
  id: string;
  rider_id: string;
  territory_id: string | null;
  amount: number;
  channel: TopupChannel;
  collected_by: 'franchisor' | 'operator';
  reference: string;
  provider: string | null;
  provider_ref: string | null;
  checkout_url: string | null;
  status: TopupStatus;
  paid_at: string | null;
  expires_at: string | null;
  note: string | null;
  created_at: string;
}

export interface RiderWalletRow {
  rider_id: string;
  rider_name: string;
  mobile_number: string;
  territory_id: string | null;
  balance: number;
  overdue: number;
  locked: boolean;
  last_topup_at: string | null;
  charged_30d: number;
  topped_up_30d: number;
}

export interface OperatorDayRow {
  territory_id: string;
  territory_name: string;
  business_day: string;
  deliveries: number;
  gross: number;
  royalty: number;
  share: number;
  topups_collected: number;
  net: number;
  paid: number;
  unpaid: number;
  payout_id: string | null;
}

export interface PayoutQueueRow {
  territory_id: string;
  territory_name: string;
  oldest_day: string | null;
  days_owed: number;
  unpaid: number;
  today_net: number;
}

export interface OperatorPayout {
  id: string;
  territory_id: string;
  period_start: string;
  period_end: string;
  amount: number;
  method: string | null;
  reference: string | null;
  receipt_url: string | null;
  note: string | null;
  status: 'paid' | 'void';
  paid_at: string;
}

const row = <T>(data: unknown): T | null =>
  (Array.isArray(data) ? (data[0] as T) : (data as T)) ?? null;

/** One rider's wallet. Omit the id for the signed-in rider's own. */
export async function walletSummary(
  db: SupabaseClient, riderId?: string,
): Promise<WalletSummary | null> {
  const { data, error } = await db.rpc('rider_wallet_summary', { p_rider: riderId ?? null });
  if (error) throw error;
  const s = row<Record<string, unknown>>(data);
  if (!s) return null;
  return {
    riderId: String(s.rider_id ?? ''),
    riderName: String(s.rider_name ?? ''),
    territoryId: (s.territory_id as string | null) ?? null,
    balance: Number(s.balance ?? 0),
    balanceYesterday: Number(s.balance_yesterday ?? 0),
    overdue: Number(s.overdue ?? 0),
    locked: Boolean(s.locked),
    low: Boolean(s.low),
    walletEnabled: Boolean(s.wallet_enabled),
    minTopup: Number(s.min_topup ?? 0),
    maxTopup: Number(s.max_topup ?? 0),
    creditLimit: Number(s.credit_limit ?? 0),
    lastTopupAt: (s.last_topup_at as string | null) ?? null,
    chargedToday: Number(s.charged_today ?? 0),
  };
}

/** The statement, newest first, each line carrying the balance it left behind. */
export async function walletStatement(
  db: SupabaseClient,
  opts: { riderId?: string; from?: string; to?: string; limit?: number } = {},
): Promise<WalletEntry[]> {
  const { data, error } = await db.rpc('rider_wallet_statement', {
    p_rider: opts.riderId ?? null,
    p_from: opts.from ?? null,
    p_to: opts.to ?? null,
    p_limit: opts.limit ?? 200,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((e) => ({
    id: String(e.id),
    createdAt: String(e.created_at),
    businessDay: String(e.business_day),
    kind: e.kind as WalletEntryKind,
    amount: Number(e.amount ?? 0),
    balanceAfter: Number(e.balance_after ?? 0),
    note: (e.note as string | null) ?? null,
    orderId: (e.order_id as string | null) ?? null,
    topupId: (e.topup_id as string | null) ?? null,
  }));
}

/** A rider's top-ups, newest first. */
export async function listTopups(
  db: SupabaseClient, riderId?: string, limit = 50,
): Promise<WalletTopup[]> {
  let q = db
    .from('wallet_topups')
    .select('id, rider_id, territory_id, amount, channel, collected_by, reference, provider, provider_ref, checkout_url, status, paid_at, expires_at, note, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (riderId) q = q.eq('rider_id', riderId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as WalletTopup[];
}

/**
 * Start a card / e-wallet top-up and get back somewhere to pay.
 *
 * This goes through the edge function rather than the database, because the
 * payment page is created at Xendit and the secret that talks to them must
 * never reach a phone.
 */
export async function startTopup(
  db: SupabaseClient, amount: number, returnUrl?: string,
): Promise<{ reference: string; amount: number; checkoutUrl: string | null }> {
  const { data, error } = await db.functions.invoke('wallet-topup', {
    body: { amount, returnUrl },
  });
  if (error) {
    // The function answers with a readable message on 4xx/5xx; supabase-js
    // hides it inside the response, so dig it out rather than showing "failed".
    const res = (error as { context?: Response }).context;
    if (res) {
      const detail = await res.json().catch(() => null) as { message?: string } | null;
      if (detail?.message) throw new Error(detail.message);
    }
    throw error;
  }
  return {
    reference: String(data?.reference ?? ''),
    amount: Number(data?.amount ?? amount),
    checkoutUrl: (data?.checkoutUrl as string | null) ?? null,
  };
}

/** Cash over the counter, a bank transfer, or a credit the office is giving. */
export async function recordTopup(
  db: SupabaseClient,
  riderId: string,
  amount: number,
  channel: Exclude<TopupChannel, 'xendit'> = 'cash',
  reference?: string,
  note?: string,
): Promise<WalletTopup> {
  const { data, error } = await db.rpc('wallet_record_topup', {
    p_rider: riderId, p_amount: amount, p_channel: channel,
    p_reference: reference ?? null, p_note: note ?? null,
  });
  if (error) throw error;
  return row<WalletTopup>(data)!;
}

/** A correction, in either direction. The reason is not optional. */
export async function adjustWallet(
  db: SupabaseClient, riderId: string, amount: number, note: string,
): Promise<void> {
  const { error } = await db.rpc('wallet_adjust', {
    p_rider: riderId, p_amount: amount, p_note: note,
  });
  if (error) throw error;
}

/** Every wallet a city is responsible for, the emptiest first. */
export async function territoryRiderWallets(
  db: SupabaseClient, territoryId?: string,
): Promise<RiderWalletRow[]> {
  const { data, error } = await db.rpc('territory_rider_wallets', {
    p_territory: territoryId ?? null,
  });
  if (error) throw error;
  return (data ?? []) as RiderWalletRow[];
}

/** What the franchisor owes each city, day by day. */
export async function operatorDailyShare(
  db: SupabaseClient,
  opts: { territoryId?: string; from?: string; to?: string } = {},
): Promise<OperatorDayRow[]> {
  const { data, error } = await db.rpc('operator_daily_share', {
    p_territory: opts.territoryId ?? null,
    p_from: opts.from ?? null,
    p_to: opts.to ?? null,
  });
  if (error) throw error;
  return (data ?? []) as OperatorDayRow[];
}

/** Still outstanding, all days together. */
export async function operatorPayoutBalance(
  db: SupabaseClient, territoryId?: string,
): Promise<number> {
  const { data, error } = await db.rpc('operator_payout_balance', {
    p_territory: territoryId ?? null,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/** Every city with something outstanding — the franchisor's morning list. */
export async function payoutQueue(
  db: SupabaseClient, day?: string,
): Promise<PayoutQueueRow[]> {
  const { data, error } = await db.rpc('franchisor_payout_queue', { p_day: day ?? null });
  if (error) throw error;
  return (data ?? []) as PayoutQueueRow[];
}

/** Pay a city. Clears everything outstanding up to the end of the period. */
export async function payOperator(
  db: SupabaseClient,
  territoryId: string,
  from: string,
  to?: string,
  extra: { method?: string; reference?: string; receiptUrl?: string; note?: string } = {},
): Promise<OperatorPayout> {
  const { data, error } = await db.rpc('franchisor_pay_operator', {
    p_territory: territoryId, p_from: from, p_to: to ?? null,
    p_method: extra.method ?? null, p_reference: extra.reference ?? null,
    p_receipt_url: extra.receiptUrl ?? null, p_note: extra.note ?? null,
  });
  if (error) throw error;
  return row<OperatorPayout>(data)!;
}

/** A correction on what a city is owed. Franchisor only. */
export async function adjustOperatorShare(
  db: SupabaseClient, territoryId: string, amount: number, note: string, day?: string,
): Promise<void> {
  const { error } = await db.rpc('franchisor_adjust_operator_share', {
    p_territory: territoryId, p_amount: amount, p_note: note, p_day: day ?? null,
  });
  if (error) throw error;
}

/** What has actually been paid out, newest first. */
export async function listOperatorPayouts(
  db: SupabaseClient, territoryId?: string, limit = 100,
): Promise<OperatorPayout[]> {
  let q = db
    .from('operator_payouts')
    .select('id, territory_id, period_start, period_end, amount, method, reference, receipt_url, note, status, paid_at')
    .order('period_end', { ascending: false })
    .limit(limit);
  if (territoryId) q = q.eq('territory_id', territoryId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as OperatorPayout[];
}

// ---------------------------------------------------------------------------
// The payment account itself.
//
// The secret key is write-only from here down: it goes in through
// set_xendit_credentials() and comes back only as a four-character hint and a
// timestamp. Nothing in this file can read a Xendit key, which is the point.
// ---------------------------------------------------------------------------

export interface XenditStatus {
  enabled: boolean;
  mode: 'test' | 'live';
  keySet: boolean;
  keyHint: string | null;
  keySetAt: string | null;
  callbackSet: boolean;
  callbackSetAt: string | null;
  successUrl: string | null;
  invoiceDuration: number;
  walletEnabled: boolean;
  /** False on a database with no Vault, where secrets must stay in the shell. */
  vaultAvailable: boolean;
}

export interface XenditTestResult {
  ok: boolean;
  reason?: 'no_key' | 'rejected' | 'unreachable' | 'error';
  message?: string;
  mode?: 'test' | 'live';
  keyIsProduction?: boolean;
  /** A production key on an account set to test, or the other way round. */
  modeMismatch?: boolean;
  balance?: number | null;
  callbackTokenSet?: boolean;
}

const asStatus = (data: unknown): XenditStatus => {
  const s = (data ?? {}) as Record<string, unknown>;
  return {
    enabled: Boolean(s.enabled),
    mode: (s.mode as 'test' | 'live') ?? 'test',
    keySet: Boolean(s.keySet),
    keyHint: (s.keyHint as string | null) ?? null,
    keySetAt: (s.keySetAt as string | null) ?? null,
    callbackSet: Boolean(s.callbackSet),
    callbackSetAt: (s.callbackSetAt as string | null) ?? null,
    successUrl: (s.successUrl as string | null) ?? null,
    invoiceDuration: Number(s.invoiceDuration ?? 3600),
    walletEnabled: Boolean(s.walletEnabled),
    vaultAvailable: s.vaultAvailable !== false,
  };
};

/** How the payment account is set up. Never includes a secret. */
export async function xenditStatus(db: SupabaseClient): Promise<XenditStatus> {
  const { data, error } = await db.rpc('xendit_status');
  if (error) throw error;
  return asStatus(data);
}

/**
 * Save the payment account. Franchisor only.
 *
 * Leave a secret out to keep the one already stored, so changing the mode does
 * not mean retyping a key nobody can read to check.
 */
export async function saveXendit(
  db: SupabaseClient,
  patch: {
    secretKey?: string;
    callbackToken?: string;
    mode?: 'test' | 'live';
    enabled?: boolean;
    successUrl?: string;
    invoiceDuration?: number;
  },
): Promise<XenditStatus> {
  const { data, error } = await db.rpc('set_xendit_credentials', {
    p_secret_key: patch.secretKey ?? null,
    p_callback_token: patch.callbackToken ?? null,
    p_mode: patch.mode ?? null,
    p_enabled: patch.enabled ?? null,
    p_success_url: patch.successUrl ?? null,
    p_invoice_duration: patch.invoiceDuration ?? null,
  });
  if (error) throw error;
  return asStatus(data);
}

/** Forget the credentials entirely. */
export async function disconnectXendit(db: SupabaseClient): Promise<XenditStatus> {
  const { data, error } = await db.rpc('clear_xendit_credentials');
  if (error) throw error;
  return asStatus(data);
}

/** Ask Xendit whether the stored key actually works. */
export async function testXendit(db: SupabaseClient): Promise<XenditTestResult> {
  const { data, error } = await db.functions.invoke('xendit-test', { body: {} });
  if (error) {
    const res = (error as { context?: Response }).context;
    if (res) {
      const detail = await res.json().catch(() => null) as { message?: string } | null;
      if (detail?.message) return { ok: false, reason: 'error', message: detail.message };
    }
    throw error;
  }
  return (data ?? { ok: false }) as XenditTestResult;
}
