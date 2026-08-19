/**
 * Pabili (buy-anything) budget logic.
 *
 * A Pabili request carries an estimated cost and a spending cap. The cap is the
 * amount the rider must not exceed without confirming with the customer — the
 * gap between estimate and cap is the built-in buffer that keeps riders from
 * being out of pocket on small overages (resolves open decision #5).
 *
 * The customer pays the ACTUAL cost of goods (per receipt) plus the delivery
 * fee. Commission is 15% of the delivery fee only — goods are a pass-through.
 */

import { roundPeso } from './money.ts';
import { commission } from './pricing.ts';

export interface PabiliBudget {
  /** What the customer expects the goods to cost. */
  estimate: number;
  /** Hard ceiling the rider must not exceed without confirmation. */
  cap: number;
}

export type BudgetVerdict = 'within_estimate' | 'within_cap' | 'over_cap';

/** Validate an estimate/cap pair (cap must be at least the estimate). */
export function validateBudget(budget: PabiliBudget): void {
  if (budget.estimate < 0 || budget.cap < 0) {
    throw new Error('estimate and cap must be non-negative');
  }
  if (budget.cap < budget.estimate) {
    throw new Error('cap must be greater than or equal to the estimate');
  }
}

/** Where an actual spend lands relative to the estimate and cap. */
export function budgetVerdict(actual: number, budget: PabiliBudget): BudgetVerdict {
  if (actual > budget.cap) return 'over_cap';
  if (actual > budget.estimate) return 'within_cap';
  return 'within_estimate';
}

/** True when the actual spend exceeds the cap (needs customer confirmation). */
export function needsOverBudgetConfirmation(actual: number, budget: PabiliBudget): boolean {
  return budgetVerdict(actual, budget) === 'over_cap';
}

/** Amount over the cap (0 when within). */
export function overCapAmount(actual: number, budget: PabiliBudget): number {
  return roundPeso(Math.max(0, actual - budget.cap));
}

export interface PabiliCollectibleInput {
  /** What the receipt actually came to. */
  actualGoods: number;
  deliveryFee: number;
  /** Per-store fees — one for each store past the first on a multi-stop run. */
  storeFeeTotal?: number;
  /** Operator-set convenience fee. */
  convenienceFee?: number;
}

/**
 * Final amount to collect from the customer for a Pabili order.
 *
 * Every fee the customer was quoted, plus the real cost of the goods. Named
 * fields rather than positional arguments because this went out for a while
 * silently missing the per-store fee: the customer's checkout added it, the
 * order stored it, commission was charged on it, and the rider was told to
 * collect a total without it — so the operator ate ₱25 a stop.
 */
export function pabiliCollectible(input: PabiliCollectibleInput): number {
  return roundPeso(
    input.actualGoods + input.deliveryFee + (input.storeFeeTotal ?? 0) + (input.convenienceFee ?? 0),
  );
}

/** Operator commission for a Pabili order — 15% of the delivery fee. */
export function pabiliCommission(deliveryFee: number): number {
  return commission({ deliveryFee, storeCount: 1 });
}
