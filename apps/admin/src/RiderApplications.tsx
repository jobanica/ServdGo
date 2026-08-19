import { useEffect, useState } from 'react';
import { listRiders, setRiderApplicationStatus, getRiderDocumentUrl, RIDER_DOCUMENT_LABELS, type RiderDocumentKind } from '@servdgo/supabase';
import type { RiderApplicationStatus } from '@servdgo/shared';
import { errMessage } from '@servdgo/shared';
import { supabase } from './lib/supabase.ts';
import { Th, Td, Muted, ErrorNote, StatusPill, Card } from './ui.tsx';

interface RiderRow {
  id: string;
  name: string;
  mobile_number: string;
  vehicle: string | null;
  application_status: RiderApplicationStatus;
  orcr_doc: string | null;
  license_doc: string | null;
  proof_address_doc: string | null;
}

const SAMPLE: RiderRow[] = [
  { id: 'r1', name: 'Cy Ramos', mobile_number: '0917 555 1000', vehicle: 'Motorcycle', application_status: 'pending', orcr_doc: 'sample', license_doc: 'sample', proof_address_doc: 'sample' },
  { id: 'r2', name: 'Ben Cruz', mobile_number: '0918 555 2000', vehicle: 'Motorcycle', application_status: 'approved', orcr_doc: 'sample', license_doc: 'sample', proof_address_doc: 'sample' },
  { id: 'r3', name: 'Dina Lim', mobile_number: '0919 555 3000', vehicle: 'Bicycle', application_status: 'pending', orcr_doc: 'sample', license_doc: null, proof_address_doc: null },
];

const DOC_FIELDS: { kind: RiderDocumentKind; col: keyof Pick<RiderRow, 'orcr_doc' | 'license_doc' | 'proof_address_doc'> }[] = [
  { kind: 'orcr', col: 'orcr_doc' },
  { kind: 'license', col: 'license_doc' },
  { kind: 'proof_address', col: 'proof_address_doc' },
];

/** Buttons that open each uploaded document in a new tab via a signed URL. */
function DocLinks({ row }: { row: RiderRow }) {
  const [busy, setBusy] = useState<string | null>(null);
  async function open(path: string) {
    if (!supabase) return;
    setBusy(path);
    try { window.open(await getRiderDocumentUrl(supabase, path), '_blank', 'noopener'); }
    catch { /* ignore */ }
    finally { setBusy(null); }
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {DOC_FIELDS.map(({ kind, col }) => {
        const path = row[col];
        return path ? (
          <button key={kind} onClick={() => void open(path)} disabled={busy === path}
            className="rounded border border-brand-green/40 px-2 py-0.5 text-xs font-medium text-brand-green disabled:opacity-50">
            {busy === path ? '…' : RIDER_DOCUMENT_LABELS[kind]}
          </button>
        ) : (
          <span key={kind} className="rounded border border-red-200 px-2 py-0.5 text-xs text-red-500">
            {RIDER_DOCUMENT_LABELS[kind]} ✕
          </span>
        );
      })}
    </span>
  );
}

export function RiderApplications() {
  const [rows, setRows] = useState<RiderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!supabase) { setRows(SAMPLE); setLoading(false); return; }
    setLoading(true);
    try { setRows((await listRiders(supabase)) as RiderRow[]); setError(null); }
    catch (e) { setError(errMessage(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function decide(id: string, status: RiderApplicationStatus) {
    if (!supabase) { setRows((rs) => rs.map((r) => r.id === id ? { ...r, application_status: status } : r)); return; }
    await setRiderApplicationStatus(supabase, id, status);
    await load();
  }

  if (loading) return <Muted>Loading…</Muted>;
  if (error) return <ErrorNote msg={error} />;
  if (rows.length === 0) return <Muted>No rider applications yet.</Muted>;

  return (
    <Card title="Rider applications">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-black/50">
            <tr className="border-b border-black/5"><Th>Name</Th><Th>Mobile</Th><Th>Vehicle</Th><Th>Documents</Th><Th>Status</Th><Th> </Th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-black/[0.04]">
                <Td className="font-medium">{r.name}</Td>
                <Td>{r.mobile_number}</Td>
                <Td>{r.vehicle ?? '—'}</Td>
                <Td><DocLinks row={r} /></Td>
                <Td><StatusPill status={r.application_status} /></Td>
                <Td>
                  {r.application_status === 'pending' && (
                    <span className="flex gap-2">
                      <button onClick={() => decide(r.id, 'approved')}
                        className="rounded-lg bg-brand-green px-3 py-1.5 text-xs font-semibold text-white">Approve</button>
                      <button onClick={() => decide(r.id, 'rejected')}
                        className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600">Reject</button>
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
