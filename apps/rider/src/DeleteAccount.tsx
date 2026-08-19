import { useState } from 'react';
import { deleteMyAccount, signOut } from '@servdgo/supabase';
import { errMessage, ACCOUNT_DELETION_URL } from '@servdgo/shared';
import { supabase } from './lib/supabase.ts';

/**
 * Account deletion, as Google Play requires of any app with accounts.
 *
 * Two steps on purpose: this cannot be undone, and a mis-tap on a settings
 * screen shouldn't end someone's account. The server refuses while a delivery
 * is in flight or commission is owed, and says which — that message is shown
 * verbatim rather than replaced with something vaguer.
 */
export function DeleteAccount() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (!supabase) return;
    setBusy(true); setErr(null); setBlocked(null);
    try {
      const res = await deleteMyAccount(supabase);
      if (!res.deleted) { setBlocked(res.message ?? 'Your account could not be deleted right now.'); return; }
      await signOut(supabase);
      window.location.reload();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <p className="text-sm font-bold text-brand-ink">Delete account</p>
      <p className="mt-1 text-sm text-black/55">
        Permanently deletes your login and personal details. Completed deliveries stay in the
        operator's books for tax and settlement, stripped of anything identifying you.{' '}
        <a href={ACCOUNT_DELETION_URL} target="_blank" rel="noreferrer" className="text-brand-purple">
          What's deleted →
        </a>
      </p>

      {blocked && <p className="mt-3 rounded-xl bg-brand-yellow/20 px-3 py-2 text-sm text-yellow-900">{blocked}</p>}
      {err && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}

      {!confirming ? (
        <button onClick={() => { setConfirming(true); setBlocked(null); setErr(null); }}
          className="mt-3 w-full rounded-xl border border-red-300 py-2.5 text-sm font-bold text-red-600">
          Delete my account
        </button>
      ) : (
        <div className="mt-3 rounded-xl bg-red-50 p-3">
          <p className="text-sm font-semibold text-red-800">This cannot be undone.</p>
          <p className="mt-0.5 text-xs text-red-700/80">
            You'll be signed out and won't be able to log back in with this account.
          </p>
          <div className="mt-3 flex gap-2">
            <button onClick={() => setConfirming(false)} disabled={busy}
              className="flex-1 rounded-lg border border-black/10 bg-white py-2 text-sm font-semibold text-black/60">
              Keep my account
            </button>
            <button onClick={() => void run()} disabled={busy}
              className="flex-1 rounded-lg bg-red-600 py-2 text-sm font-bold text-white disabled:opacity-60">
              {busy ? 'Deleting…' : 'Yes, delete'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
