/**
 * The request queue riders take orders from.
 *
 * The pool is first-come, first-served: the order that has waited longest is
 * the one a rider must answer next. Without that rule the oldest request is the
 * one everybody scrolls past — riders cherry-pick the big-ticket runs and a
 * cheap order placed at 6pm is still sitting there at 8pm.
 *
 * A rider is never forced to take a job: passing on the head of the queue moves
 * them to the next one. What they cannot do is skip it and accept something
 * further down while it is still waiting for an answer.
 *
 * Transfers (a delivery released mid-run by another rider, often with the goods
 * already bought) jump the queue as a block — that customer has been waiting
 * longest of all — and are themselves ordered oldest-first.
 */

/** The minimum an order needs to take its place in the queue. */
export interface QueuedRequest {
  id: string;
  /** ISO timestamp the order was placed. */
  createdAt: string;
  /** Released by another rider — served before brand-new requests. */
  isTransfer: boolean;
}

/**
 * The pool in the order riders must answer it: transfers first, then oldest
 * first within each group. Pure — returns a new array.
 *
 * @example
 * sortRequestQueue([
 *   { id: 'b', createdAt: '2026-08-04T10:00:00Z', isTransfer: false },
 *   { id: 'a', createdAt: '2026-08-04T11:00:00Z', isTransfer: true },
 * ]).map((o) => o.id) // ['a', 'b']
 */
export function sortRequestQueue<T extends QueuedRequest>(orders: readonly T[]): T[] {
  return [...orders].sort(
    (a, b) =>
      Number(b.isTransfer) - Number(a.isTransfer) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

/** The one request the rider must answer next, or null when the pool is empty. */
export function queueHead<T extends QueuedRequest>(orders: readonly T[]): T | null {
  return sortRequestQueue(orders)[0] ?? null;
}

/**
 * Whether this order is the rider's to answer right now. Everything behind the
 * head is locked until the head is accepted or passed on.
 */
export function isQueueHead(orders: readonly QueuedRequest[], orderId: string): boolean {
  return queueHead(orders)?.id === orderId;
}

/** 1-based position in the queue; 0 when the order isn't in the pool. */
export function queuePosition(orders: readonly QueuedRequest[], orderId: string): number {
  return sortRequestQueue(orders).findIndex((o) => o.id === orderId) + 1;
}
