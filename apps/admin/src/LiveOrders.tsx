import { useEffect, useState } from 'react';
import { listActiveOrdersAdmin, adminCancelOrder } from '@servdgo/supabase';
import { supabase } from './lib/supabase.ts';
import { Th, Td, Muted, ErrorNote, Card, peso } from './ui.tsx';
import { errMessage } from '@servdgo/shared';

interface RiderRef { id: string; name: string; mobile_number: string | null }
interface OrderRow {
  id: string;
  service_type: string;
  status: string;
  delivery_fee: number;
  commission_amount: number;
  customer_contact: string;
  created_at: string;
  rider: RiderRef | null;
  notes?: string | null;
}

const now = new Date();
const SAMPLE: OrderRow[] = [
  { id: 'o1', service_type: 'food', status: 'pending', delivery_fee: 50, commission_amount: 7.5, customer_contact: '0917 111 2222', created_at: new Date(now.getTime() - 3 * 60000).toISOString(), rider: null },
  { id: 'o2', service_type: 'pabili', status: 'accepted', delivery_fee: 60, commission_amount: 9, customer_contact: '0917 333 4444', created_at: new Date(now.getTime() - 18 * 60000).toISOString(), rider: { id: 'r1', name: 'Juan Dela Cruz', mobile_number: '0917 000 1111' } },
  { id: 'o3', service_type: 'padala', status: 'on_the_way', delivery_fee: 40, commission_amount: 6, customer_contact: '0917 555 6666', created_at: new Date(now.getTime() - 42 * 60000).toISOString(), rider: { id: 'r2', name: 'Maria Santos', mobile_number: '0917 000 2222' } },
];

const serviceColor: Record<string, string> = {
  food: 'bg-brand-orange/15 text-green-800',
  pabili: 'bg-brand-charcoal/15 text-brand-charcoal',
  padala: 'bg-brand-yellow/30 text-yellow-800',
};

/** "2:45 PM" (Manila) plus a relative hint like "3m ago". */
function formatWhen(iso: string): { time: string; ago: string } {
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago`
    : mins < 1440 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;
  return { time, ago };
}

export function LiveOrders({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);

  async function reload() {
    if (!supabase) return;
    try { setRows((await listActiveOrdersAdmin(supabase)) as OrderRow[]); setError(null); }
    catch (e) { setError(errMessage(e)); }
  }

  async function cancel(o: OrderRow) {
    if (!supabase) return;
    const reason = window.prompt(
      `Cancel this ${o.service_type} order?\n\nReason (added to the order notes):`, '');
    if (reason === null) return;
    setBusyId(o.id);
    try {
      const ok = await adminCancelOrder(supabase, o.id, reason.trim() || undefined);
      if (!ok) window.alert('This order could not be cancelled (already delivered?).');
      await reload();
    } catch (e) { setError(errMessage(e)); }
    finally { setBusyId(null); }
  }

  useEffect(() => {
    let alive = true;
    async function load() {
      if (!supabase) { setRows(SAMPLE); setLoading(false); return; }
      try {
        const data = (await listActiveOrdersAdmin(supabase)) as OrderRow[];
        if (alive) { setRows(data); setError(null); }
      } catch (e) {
        if (alive) setError(errMessage(e));
      } finally {
        if (alive) setLoading(false);
      }
    }
    void load();
    // Keep the timestamps and assignments fresh.
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (loading) return <Muted>Loading…</Muted>;
  if (error) return <ErrorNote msg={error} />;

  const table = (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-black/50">
          <tr className="border-b border-black/5">
            <Th>Time</Th><Th>Service</Th><Th>Status</Th><Th>Rider</Th><Th>Contact</Th><Th>Fee</Th><Th>Commission</Th><Th> </Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><Td className="text-black/40">No active orders right now.</Td></tr>}
          {rows.map((o) => {
            const when = formatWhen(o.created_at);
            return (
              <tr key={o.id} className="border-b border-black/[0.04]">
                <Td>
                  <span className="font-medium">{when.time}</span>
                  <span className="mt-0.5 block text-xs text-black/40">{when.ago}</span>
                </Td>
                <Td><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${serviceColor[o.service_type] ?? 'bg-black/5'}`}>{o.service_type}</span></Td>
                <Td className="capitalize">{o.status.replaceAll('_', ' ')}</Td>
                <Td>
                  {o.rider ? (
                    <>
                      <span className="font-medium">{o.rider.name}</span>
                      {o.rider.mobile_number && <span className="mt-0.5 block text-xs text-black/40">{o.rider.mobile_number}</span>}
                    </>
                  ) : (
                    <span className="rounded-full bg-brand-yellow/30 px-2 py-0.5 text-xs font-medium text-yellow-800">Unassigned</span>
                  )}
                </Td>
                <Td>
                  {o.customer_contact}
                  {o.notes && <span className="mt-0.5 block text-xs text-yellow-800">📝 {o.notes}</span>}
                </Td>
                <Td>{peso(o.delivery_fee)}</Td>
                <Td className="font-medium">{peso(o.commission_amount)}</Td>
                <Td>
                  <button onClick={() => cancel(o)} disabled={busyId === o.id}
                    className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-50">
                    {busyId === o.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return embedded ? table : <Card title="Live orders">{table}</Card>;
}
