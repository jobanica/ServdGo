export const inputCls =
  'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm ' +
  'outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/30';

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-black/70">{label}</span>
      {children}
    </label>
  );
}

export function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between py-0.5 text-sm">
      <span className={muted ? 'text-black/50' : ''}>{label}</span>
      <span className={muted ? 'text-black/50' : 'font-semibold'}>{value}</span>
    </div>
  );
}

export const peso = (n: number) => `₱${n.toFixed(2)}`;

export type PayChoice = 'cod' | 'rider_qr' | 'online';

const PAY_LABELS: Record<PayChoice, string> = {
  cod: 'Cash on delivery',
  rider_qr: 'GCash to rider',
  online: 'Pay online',
};

/** Payment method selector shared across the ordering flows. */
export function PaymentChoice({ value, onChange }:
  { value: PayChoice | null; onChange: (v: PayChoice) => void }) {
  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-black/70">Payment</span>
      <div className="grid grid-cols-3 gap-2">
        {(['cod', 'rider_qr', 'online'] as const).map((opt) => (
          <button key={opt} type="button" onClick={() => onChange(opt)}
            className={`rounded-lg px-2 py-2 text-xs font-medium ring-1 transition ${
              value === opt
                ? 'bg-brand-green text-white ring-brand-green'
                : 'bg-white text-black/60 ring-black/10'
            }`}>
            {PAY_LABELS[opt]}
          </button>
        ))}
      </div>
      {value === 'rider_qr' && (
        <p className="mt-1 text-xs text-black/50">
          On delivery, scan the rider's GCash/Maya QR and pay the full amount to the rider.
        </p>
      )}
      {value === 'online' && (
        <p className="mt-1 text-xs text-black/50">
          Card and e-wallet checkout isn't live yet — for now you'll pay the
          rider the full amount at the door, same as cash on delivery.
        </p>
      )}
    </div>
  );
}
