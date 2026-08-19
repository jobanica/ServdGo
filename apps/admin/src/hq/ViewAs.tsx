/**
 * Viewing a city as its operator.
 *
 * This is not a client-side filter. While a session is open the database itself
 * treats this user as that city's operator — the same rows, the same blind
 * spots — and refuses every write. So the banner is not decoration: it is the
 * only thing on screen that explains why saving anything will fail, and why the
 * HQ sections have vanished.
 *
 * Beginning or ending a session changes what every query returns, so both
 * reload the console rather than trying to reconcile what is already on screen.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  viewingAsTerritory, beginViewAs, endViewAs, listTerritories, type Territory,
} from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';

export function useViewingAs(): { territoryId: string | null; loading: boolean } {
  const [territoryId, setTerritoryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!supabase || !isSupabaseConfigured) { setLoading(false); return; }
      try {
        const id = await viewingAsTerritory(supabase);
        if (alive) setTerritoryId(id);
      } catch { /* not a franchisor, or signed out — no session either way */ }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  return { territoryId, loading };
}

/** The bar across the top of every page while a session is open. */
export function ViewAsBanner({ territoryId }: { territoryId: string }) {
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) return;
    void listTerritories(supabase)
      .then((ts) => setName(ts.find((t) => t.id === territoryId)?.name ?? null))
      .catch(() => setName(null));
  }, [territoryId]);

  async function leave() {
    if (!supabase) return;
    setBusy(true);
    try { await endViewAs(supabase); window.location.assign('/hq/tenants'); }
    catch { setBusy(false); }
  }

  return (
    <div className="sticky top-0 z-40 flex flex-wrap items-center gap-2 bg-brand-charcoal px-4 py-2 text-sm text-white">
      <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs font-bold uppercase tracking-wide">
        Viewing as operator
      </span>
      <span className="font-semibold">{name ?? 'this city'}</span>
      <span className="text-white/70">— read only, nothing can be changed from here.</span>
      <button onClick={() => void leave()} disabled={busy}
        className="ml-auto rounded-lg bg-white px-3 py-1 text-xs font-bold text-brand-charcoal hover:bg-white/90 disabled:opacity-50">
        {busy ? 'Leaving…' : 'Leave view'}
      </button>
    </div>
  );
}

/** The button on a city's page. Asks for a reason, because the visit is logged. */
export function ViewAsButton({ territory }: { territory: Territory }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = useCallback(async () => {
    if (!supabase) return;
    setBusy(true); setError(null);
    try {
      await beginViewAs(supabase, territory.id, reason.trim() || undefined);
      window.location.assign('/');
    } catch (e) { setError(errMessage(e)); setBusy(false); }
  }, [territory.id, reason]);

  if (!asking) {
    return (
      <button onClick={() => setAsking(true)}
        className="rounded-xl bg-brand-charcoal px-3 py-2 text-sm font-semibold text-white hover:opacity-90">
        View as operator
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-xl bg-black/[0.03] p-3">
      <p className="text-sm">
        You will see {territory.name} exactly as its operator does, and will not be able to
        change anything. The visit is recorded.
      </p>
      <input value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder="Why (optional) — e.g. checking a complaint"
        className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button onClick={() => void start()} disabled={busy}
          className="rounded-xl bg-brand-orange px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Starting…' : 'Start'}
        </button>
        <button onClick={() => setAsking(false)}
          className="rounded-xl px-3 py-2 text-sm font-semibold text-black/60 hover:bg-black/5">
          Cancel
        </button>
      </div>
    </div>
  );
}
