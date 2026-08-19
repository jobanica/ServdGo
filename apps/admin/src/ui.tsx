import type { RiderApplicationStatus } from '@ebd/shared';

export const peso = (n: number) => `₱${Number(n).toFixed(2)}`;

export const Th = ({ children }: { children: React.ReactNode }) =>
  <th className="px-4 py-3 font-medium">{children}</th>;
export const Td = ({ children, className = '' }: { children: React.ReactNode; className?: string }) =>
  <td className={`px-4 py-3 ${className}`}>{children}</td>;
export const Muted = ({ children }: { children: React.ReactNode }) =>
  <p className="rounded-2xl bg-white p-6 text-sm text-black/50 shadow-sm ring-1 ring-black/5">{children}</p>;
export const ErrorNote = ({ msg }: { msg: string }) =>
  <p className="rounded-2xl bg-red-50 p-4 text-sm text-red-700 ring-1 ring-red-200">{msg}</p>;

export function StatusPill({ status }: { status: RiderApplicationStatus }) {
  const cls = {
    pending: 'bg-brand-yellow/30 text-yellow-800',
    approved: 'bg-brand-green/15 text-green-800',
    rejected: 'bg-red-100 text-red-700',
  }[status];
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${cls}`}>{status}</span>;
}

/** On/off switch. */
export function Toggle({ on, onChange, disabled = false }:
  { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={() => !disabled && onChange(!on)} disabled={disabled}
      aria-pressed={on}
      className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${on ? 'bg-brand-green' : 'bg-black/20'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${on ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

/** Panel card wrapper used across sections. */
export function Card({ title, action, children }:
  { title?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between">
          {title && <h3 className="font-bold text-brand-ink">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
