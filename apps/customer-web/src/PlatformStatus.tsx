import { useCallback, useEffect, useState } from 'react';
import { getPlatformStatus, CLOSED_MESSAGE, type PlatformStatus } from '@servdgo/supabase';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';

/**
 * Whether the operator has the platform open.
 *
 * Optimistic when it can't tell: a failed lookup or a preview build must never
 * shutter a service that is actually running. Re-checked every minute so the
 * announcement clears itself when the operator reopens.
 */
export function usePlatformStatus(): PlatformStatus & { checking: boolean; recheck: () => Promise<void> } {
  const [status, setStatus] = useState<PlatformStatus>({ open: true, message: null, outstanding: 0, unassigned: 0 });
  const [checking, setChecking] = useState(true);

  const recheck = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) { setChecking(false); return; }
    try { setStatus(await getPlatformStatus(supabase)); }
    catch { /* keep the last answer; open by default */ }
    finally { setChecking(false); }
  }, []);

  useEffect(() => {
    void recheck();
    const t = setInterval(() => { void recheck(); }, 60_000);
    return () => clearInterval(t);
  }, [recheck]);

  return { ...status, checking, recheck };
}

/**
 * The closed announcement.
 *
 * Deliberately not a full-screen lock: a customer whose order is already out
 * for delivery still needs to track it and reach their rider. It stops new
 * orders and says why, which is the part that matters.
 */
export function ClosedNotice({ status }: { status: PlatformStatus }) {
  if (status.open) return null;
  return (
    <div className="mb-4 rounded-2xl bg-brand-yellow/20 p-4 ring-1 ring-brand-yellow" role="status">
      <p className="text-sm font-bold text-yellow-900">🕒 We're closed right now</p>
      <p className="mt-1 text-sm text-yellow-900/85">{status.message ?? CLOSED_MESSAGE}</p>
      <p className="mt-2 text-xs text-yellow-900/70">
        Orders already placed are still being delivered — you can track them from your account.
      </p>
    </div>
  );
}
