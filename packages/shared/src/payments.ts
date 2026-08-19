/**
 * Payment method rules.
 *
 * Three ways a customer can pay:
 *
 * - `cod`      — cash on delivery. Rider collects the full customer total and
 *                holds the operator's commission (generates a settlement balance).
 * - `online`   — pay through the app. No gateway is wired up yet, so this is
 *                collected at the door exactly like COD (see below).
 * - `rider_qr` — customer scans the rider's personal QR and pays the full amount
 *                to the rider online. Rider collects no cash at the door but still
 *                holds the operator's commission (generates a settlement balance).
 *
 * `online` used to mean the delivery portion was prepaid to the operator, so the
 * rider collected the goods cost only and owed no commission. That was written
 * for a PayMongo integration that was never built: choosing it just marked the
 * order paid while no money moved, leaving the rider unpaid for the trip and the
 * operator's commission uncollected. Until a real gateway exists, every method
 * puts the operator's cut in the rider's hands, and every method settles.
 */

import type { OrderCostBreakdown } from './pricing.ts';
import type { PaymentMethod } from './types.ts';

/**
 * Cash the rider collects from the customer at the door for a given method.
 * - cod / online: full customer total
 * - rider_qr:     0 (the full amount was paid to the rider via QR)
 */
export function collectibleAtDoor(
  breakdown: OrderCostBreakdown,
  method: PaymentMethod,
): number {
  return method === 'rider_qr' ? 0 : breakdown.customerTotal;
}

/**
 * Whether an order paid with this method adds commission to the rider's books.
 * All of them do while the money passes through the rider either way.
 */
export function generatesSettlementBalance(_method: PaymentMethod): boolean {
  return true;
}
