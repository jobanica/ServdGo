import { useState } from 'react';
import { correctOrderPins } from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase } from './lib/supabase.ts';
import { LocationPicker, type LatLngValue } from './LocationPicker.tsx';

/**
 * Correcting a pin after the order is in.
 *
 * A pin dropped on the wrong side of a street is only noticed once the order is
 * placed, and until now the only fix was cancelling and starting again. The
 * server allows it while nobody has collected anything yet, and only within a
 * short distance — this is for fixing a mistake, not relocating a delivery the
 * fee was already worked out for. Whatever changes is posted into the order
 * chat, so the rider finds out before they set off rather than at the gate.
 */
export function FixPin({ orderId, serviceType, onDone }: {
  orderId: string;
  serviceType: string;
  onDone: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [which, setWhich] = useState<'dropoff' | 'store'>('dropoff');
  const [pin, setPin] = useState<LatLngValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Only a pabili run has a "where to buy" pin the customer chose themselves.
  const canPickStore = serviceType === 'pabili';

  async function save() {
    if (!supabase || !pin) return;
    setBusy(true); setErr(null);
    try {
      const res = await correctOrderPins(supabase, orderId,
        which === 'store' ? { pickup: pin } : { dropoff: pin });
      if (!res.updated) { setErr(res.message ?? 'That pin could not be changed.'); return; }
      setDone(true);
      await onDone();
      setTimeout(() => { setOpen(false); setDone(false); setPin(null); }, 1500);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="rounded-lg border border-brand-charcoal/40 px-2.5 py-1 text-xs font-medium text-brand-charcoal">
        📍 Fix map pin
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-xl bg-black/[0.03] p-3">
      {canPickStore && (
        <div className="mb-2 flex gap-2">
          {(['dropoff', 'store'] as const).map((k) => (
            <button key={k} onClick={() => { setWhich(k); setPin(null); }}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 transition ${
                which === k ? 'bg-brand-ink text-white ring-brand-ink' : 'bg-white text-black/60 ring-black/10'}`}>
              {k === 'dropoff' ? '📍 Drop-off' : '🛒 Where to buy'}
            </button>
          ))}
        </div>
      )}

      <LocationPicker value={pin} onChange={setPin} height={190}
        kind={which === 'store' ? 'store' : 'dropoff'}
        label={which === 'store' ? 'Move the store pin' : 'Move the drop-off pin'} />

      <p className="mt-1.5 text-xs text-black/45">
        Tap the map where it should be. Only small corrections are allowed — the delivery fee was
        worked out from the original pin.
      </p>

      {err && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
      {done && <p className="mt-2 rounded-lg bg-brand-orange/15 px-3 py-2 text-xs text-green-800">✓ Pin updated — your rider has been told.</p>}

      <div className="mt-2 flex gap-2">
        <button onClick={() => { setOpen(false); setPin(null); setErr(null); }}
          className="flex-1 rounded-lg border border-black/10 bg-white py-2 text-xs font-semibold text-black/60">
          Cancel
        </button>
        <button onClick={() => void save()} disabled={busy || !pin}
          className="flex-1 rounded-lg bg-brand-orange py-2 text-xs font-bold text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save new pin'}
        </button>
      </div>
    </div>
  );
}
