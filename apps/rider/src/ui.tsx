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
