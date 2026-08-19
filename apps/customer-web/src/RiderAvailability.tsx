import { useCallback, useEffect, useState } from 'react';
import { countAvailableRiders } from '@ebd/supabase';
import type { ServiceType } from '@ebd/shared';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';

/** What the customer is told when the pool has nobody watching it. */
export const NO_RIDERS_MESSAGE =
  "Sorry, we can't take orders right now — no rider is on duty at the moment. Please try again in a little while.";

export interface RiderAvailability {
  /** How many riders could take this order right now. */
  count: number;
  /** False only when we know nobody is on duty. Unknown states stay true. */
  canOrder: boolean;
  /** Still checking — the first load, or a re-check before submitting. */
  checking: boolean;
  /** Ask again (used before placing, and by the customer's Try again button). */
  recheck: () => Promise<number>;
}

/**
 * Whether anyone is on duty to take this kind of order.
 *
 * Deliberately optimistic when the answer isn't known — a failed check or a
 * preview build must never stand between a customer and an order. Only a
 * confident zero closes the door.
 */
export function useRiderAvailability(service?: ServiceType): RiderAvailability {
  const [count, setCount] = useState<number | null>(null);
  const [checking, setChecking] = useState(true);

  const recheck = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) { setCount(1); setChecking(false); return 1; }
    setChecking(true);
    try {
      const n = await countAvailableRiders(supabase, service);
      setCount(n);
      return n;
    } catch {
      // Can't tell — let the order through rather than turn away a customer
      // over a failed lookup.
      setCount(1);
      return 1;
    } finally {
      setChecking(false);
    }
  }, [service]);

  useEffect(() => {
    let alive = true;
    void (async () => { const n = await recheck(); if (!alive) void n; })();
    // Riders come and go; re-check while the customer fills the form in.
    const t = setInterval(() => { void recheck(); }, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [recheck]);

  return { count: count ?? 0, canOrder: count == null || count > 0, checking, recheck };
}

/**
 * Shown above a form when nobody is on duty, so a customer finds out before
 * filling it in rather than at the submit button.
 */
export function NoRidersNotice({ availability }: { availability: RiderAvailability }) {
  if (availability.canOrder) return null;
  return (
    <div className="mb-4 rounded-xl bg-brand-yellow/20 p-4 ring-1 ring-brand-yellow" role="status">
      <p className="text-sm font-bold text-yellow-900">🛵 No rider available right now</p>
      <p className="mt-1 text-sm text-yellow-900/80">{NO_RIDERS_MESSAGE}</p>
      <button
        type="button"
        onClick={() => { void availability.recheck(); }}
        disabled={availability.checking}
        className="mt-3 rounded-lg bg-yellow-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
      >
        {availability.checking ? 'Checking…' : 'Check again'}
      </button>
    </div>
  );
}
