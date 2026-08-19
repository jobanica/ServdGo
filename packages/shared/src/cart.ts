/**
 * Cart logic for Food (and Pabili) orders.
 *
 * A cart may span multiple stores in one order — that is what drives the
 * per-store fee in the commission math (up to 3 stores per trip). Goods cost is
 * a pass-through; commission is on delivery + store fees only.
 */

import { orderCost, type FeeConfig, type OrderCostBreakdown, DEFAULT_FEE_CONFIG } from './pricing.ts';
import { roundPeso } from './money.ts';

export interface CartOption {
  name: string;
  priceDelta: number;
}

export interface CartLine {
  storeId: string;
  menuItemId?: string; // absent for free-text Pabili lines
  name: string;
  unitPrice: number;
  qty: number;
  options?: CartOption[];
  notes?: string;
}

/** Unit price including selected options. */
export function lineUnitPrice(line: CartLine): number {
  const opts = (line.options ?? []).reduce((sum, o) => sum + o.priceDelta, 0);
  return roundPeso(line.unitPrice + opts);
}

/** Extended price for a line (unit incl. options × qty). */
export function lineTotal(line: CartLine): number {
  return roundPeso(lineUnitPrice(line) * line.qty);
}

/** Sum of all line totals — the goods cost the rider fronts. */
export function goodsCost(lines: readonly CartLine[]): number {
  return roundPeso(lines.reduce((sum, l) => sum + lineTotal(l), 0));
}

/** How many distinct stores the cart touches. */
export function distinctStoreCount(lines: readonly CartLine[]): number {
  return new Set(lines.map((l) => l.storeId)).size;
}

/** Max stores a single order/trip may span. */
export const MAX_STORES_PER_ORDER = 3;

/** True when the cart is within the per-trip store limit. */
export function withinStoreLimit(lines: readonly CartLine[]): boolean {
  return distinctStoreCount(lines) <= MAX_STORES_PER_ORDER;
}

/**
 * Full cost breakdown for a cart, given the delivery fee for the order.
 * Combines goods cost (pass-through) with the fee/commission math.
 */
export function summarizeCart(
  lines: readonly CartLine[],
  deliveryFee: number,
  config: FeeConfig = DEFAULT_FEE_CONFIG,
): OrderCostBreakdown {
  return orderCost(
    { deliveryFee, storeCount: distinctStoreCount(lines), goodsCost: goodsCost(lines) },
    config,
  );
}
