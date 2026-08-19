import { useEffect, useState } from 'react';
import { listStaff, setUserRole, revokeStaff, createStaff, type StaffMember } from '@servdgo/supabase';
import { STAFF_ROLES, ROLE_LABEL, type StaffRole,
  errMessage,
} from '@servdgo/shared';
import { supabase } from './lib/supabase.ts';
import { Card, Th, Td, Muted, ErrorNote } from './ui.tsx';

const SAMPLE: StaffMember[] = [
  { id: 's1', full_name: 'owner@servdgo.ph', role: 'admin' },
  { id: 's2', full_name: 'manager@servdgo.ph', role: 'manager' },
  { id: 's3', full_name: 'dispatch@servdgo.ph', role: 'dispatcher' },
];

const roleChip: Record<StaffRole, string> = {
  admin: 'bg-brand-charcoal/15 text-brand-charcoal',
  manager: 'bg-brand-orange/15 text-green-800',
  dispatcher: 'bg-brand-yellow/30 text-yellow-800',
  support: 'bg-black/5 text-black/60',
};

const inp = 'rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-brand-orange';

export function Staff() {
  const [rows, setRows] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-staff form
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<StaffRole>('dispatcher');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    if (!supabase) { setRows(SAMPLE); setLoading(false); return; }
    setLoading(true);
    try { setRows(await listStaff(supabase)); setError(null); }
    catch (e) { setError(errMessage(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function changeRole(m: StaffMember, next: StaffRole) {
    if (!supabase) { setRows((rs) => rs.map((x) => x.id === m.id ? { ...x, role: next } : x)); return; }
    await setUserRole(supabase, m.id, next);
    await load();
  }
  async function revoke(m: StaffMember) {
    if (!supabase) { setRows((rs) => rs.filter((x) => x.id !== m.id)); return; }
    await revokeStaff(supabase, m.id);
    await load();
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setNotice(null); setError(null);
    try {
      if (!supabase) { setNotice('Connect Supabase and deploy create-staff to add accounts.'); return; }
      await createStaff(supabase, { email, password, role });
      setEmail(''); setPassword('');
      setNotice('Staff account created.');
      await load();
    } catch (e) {
      setError(errMessage(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="max-w-3xl space-y-5">
      <Card title="Add staff account">
        <form onSubmit={add} className="flex flex-wrap items-end gap-3">
          <label className="flex-1"><span className="mb-1 block text-xs font-medium text-black/60">Email</span>
            <input type="email" required className={inp + ' w-full'} value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="flex-1"><span className="mb-1 block text-xs font-medium text-black/60">Temp password</span>
            <input type="text" required minLength={6} className={inp + ' w-full'} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <label><span className="mb-1 block text-xs font-medium text-black/60">Role</span>
            <select className={inp} value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
              {STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select></label>
          <button disabled={busy} className="rounded-lg bg-brand-orange px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
            {busy ? 'Adding…' : 'Add'}
          </button>
        </form>
        {notice && <p className="mt-2 text-sm text-green-700">✓ {notice}</p>}
        <p className="mt-2 text-xs text-black/40">
          Roles: Admin (full), Manager (ops + settlements), Dispatcher (orders + riders), Support (orders + broadcast).
        </p>
      </Card>

      {error && <ErrorNote msg={error} />}
      {loading ? <Muted>Loading…</Muted> : (
        <Card title="Staff">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-black/50">
                <tr className="border-b border-black/5"><Th>Member</Th><Th>Role</Th><Th> </Th></tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} className="border-b border-black/[0.04]">
                    <Td className="font-medium">{m.full_name ?? m.id.slice(0, 8)}</Td>
                    <Td>
                      <select value={m.role} onChange={(e) => changeRole(m, e.target.value as StaffRole)}
                        className={`rounded-full px-2.5 py-1 text-xs font-medium ${roleChip[m.role]}`}>
                        {STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    </Td>
                    <Td>
                      <button onClick={() => revoke(m)}
                        className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600">
                        Revoke
                      </button>
                    </Td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><Td className="text-black/40">No staff yet.</Td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
