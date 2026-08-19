import { useCallback, useEffect, useState } from 'react';
import { getPlatformStatus, CLOSED_MESSAGE, type PlatformStatus } from '@ebd/supabase';
import { supabase } from './lib/supabase.ts';

/**
 * Whether the operator has the platform open.
 *
 * Optimistic when it can't tell — a failed lookup must never strand a rider
 * mid-shift. Re-checked every minute so a reopen clears the notice by itself.
 */
export function usePlatformStatus(): PlatformStatus & { recheck: () => Promise<void> } {
  const [status, setStatus] = useState<PlatformStatus>({ open: true, message: null, outstanding: 0, unassigned: 0 });

  const recheck = useCallback(async () => {
    if (!supabase) return;
    try { setStatus(await getPlatformStatus(supabase)); } catch { /* keep the last answer */ }
  }, []);

  useEffect(() => {
    void recheck();
    const t = setInterval(() => { void recheck(); }, 60_000);
    return () => clearInterval(t);
  }, [recheck]);

  return { ...status, recheck };
}

/**
 * What a rider sees once the operator closes.
 *
 * Two different situations, and conflating them would strand deliveries:
 * while orders are still outstanding there is work to finish, so this is a
 * banner over a fully working app. Once the queue is empty there is nothing
 * left to do, and the app says so plainly.
 */
export function ClosedBanner({ status, workLeft }: { status: PlatformStatus; workLeft: number }) {
  if (status.open) return null;
  const draining = workLeft > 0;
  return (
    <div className={`mb-4 rounded-2xl p-4 ring-1 ${
      draining ? 'bg-brand-yellow/20 ring-brand-yellow' : 'bg-black/[0.04] ring-black/10'}`} role="status">
      <p className={`text-sm font-bold ${draining ? 'text-yellow-900' : 'text-black/70'}`}>
        🕒 Easy Buy Delivery is closed
      </p>
      <p className={`mt-1 text-sm ${draining ? 'text-yellow-900/85' : 'text-black/55'}`}>
        {status.message ?? CLOSED_MESSAGE}
      </p>
      <p className={`mt-2 text-xs ${draining ? 'text-yellow-900/75' : 'text-black/45'}`}>
        {draining
          ? `No new orders are coming in. Please finish what's already on the board — ${workLeft} still to complete.`
          : 'Nothing left in the queue. Go offline and enjoy the rest of your day.'}
      </p>
    </div>
  );
}
