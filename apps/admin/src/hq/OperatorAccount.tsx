/**
 * The franchisee's login, made here.
 *
 * There is no sign-up screen in ServdGo and there should not be one: an account
 * that can open a city's console is an account that can see its customers'
 * addresses and move its money. So the franchisor makes it, hands over the
 * details, and the franchisee changes the password with "Forgot password?" on
 * the sign-in screen.
 *
 * The password is shown once, here, and never stored anywhere we can read it
 * back — so it is copied now or reset later.
 */
import { useState } from 'react';
import {
  createStaff, generatePassword, assignTerritoryOperator, EmailTakenError,
  type Territory, type StaffMember,
} from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { Card, ErrorNote } from '../ui.tsx';

const inp = 'w-full rounded-lg border border-black/10 px-3 py-2 text-sm';

interface Made {
  email: string;
  password: string | null;
  existing: boolean;
}

export function OperatorAccount({ territory, staff, onCreated }: {
  territory: Territory;
  staff: StaffMember[];
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(() => generatePassword());
  const [made, setMade] = useState<Made | null>(null);
  const [takenBy, setTakenBy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const appointed = staff.find((s) => s.id === territory.operator_profile_id);

  async function create(attachExisting: boolean) {
    if (!supabase) return;
    setBusy(true); setError(null); setTakenBy(null);
    try {
      const result = await createStaff(supabase, {
        email: email.trim(),
        password,
        role: 'admin',
        fullName: name.trim() || undefined,
        territoryId: territory.id,
        appointAsOperator: true,
        attachExisting,
      });
      setMade({
        email: email.trim(),
        password: result.existing ? null : password,
        existing: result.existing,
      });
      setName(''); setEmail(''); setPassword(generatePassword());
      onCreated();
    } catch (e) {
      if (e instanceof EmailTakenError) setTakenBy(errMessage(e));
      else setError(errMessage(e));
    } finally { setBusy(false); }
  }

  async function copyAll() {
    if (!made?.password) return;
    const text = [
      `ServdGo — ${territory.name} operator console`,
      `Sign in: ${window.location.origin}`,
      `Email: ${made.email}`,
      `Temporary password: ${made.password}`,
      '',
      'Change the password after your first sign-in with "Forgot password?".',
    ].join('\n');
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  if (!isSupabaseConfigured) return null;

  return (
    <Card title="Operator account">
      {appointed ? (
        <p className="text-sm text-black/60">
          <b>{appointed.full_name ?? 'Someone'}</b> currently runs {territory.name}. Making another
          account here replaces them as the operator of record — their own account keeps working
          until you change its role under Staff.
        </p>
      ) : (
        <p className="text-sm text-black/60">
          {territory.name} has nobody running it yet. Create the franchisee's login here and send
          them the details — there is no sign-up screen, so this is the only way in.
        </p>
      )}

      {error && <div className="mt-3"><ErrorNote msg={error} /></div>}

      {made ? (
        <div className="mt-4 rounded-xl bg-brand-yellow/20 p-4 ring-1 ring-brand-yellow">
          {made.existing ? (
            <>
              <p className="font-bold">That account now runs {territory.name}.</p>
              <p className="mt-1 text-sm">
                It already existed, so its password is unchanged — {made.email} signs in with
                whatever they use today.
              </p>
            </>
          ) : (
            <>
              <p className="font-bold">Send these once. The password is not stored.</p>
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex gap-2">
                  <dt className="w-24 text-black/50">Sign in</dt>
                  <dd className="font-mono break-all">{window.location.origin}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 text-black/50">Email</dt>
                  <dd className="font-mono break-all">{made.email}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 text-black/50">Password</dt>
                  <dd className="font-mono break-all">{made.password}</dd>
                </div>
              </dl>
              <button onClick={() => void copyAll()}
                className="mt-3 rounded-xl bg-brand-orange px-3 py-2 text-sm font-semibold text-white">
                {copied ? 'Copied' : 'Copy the whole message'}
              </button>
            </>
          )}
          <button onClick={() => setMade(null)}
            className="ml-2 rounded-xl px-3 py-2 text-sm font-semibold text-black/60 hover:bg-black/5">
            Done
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-black/40">
                Their name
              </span>
              <input className={`${inp} mt-1`} value={name} placeholder="Juan dela Cruz"
                onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-black/40">
                Their email
              </span>
              <input className={`${inp} mt-1`} type="email" value={email}
                placeholder="operator@example.com"
                onChange={(e) => setEmail(e.target.value)} />
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-black/40">
              Temporary password
            </span>
            <div className="mt-1 flex gap-2">
              <input className={`${inp} font-mono`} value={password}
                onChange={(e) => setPassword(e.target.value)} />
              <button type="button" onClick={() => setPassword(generatePassword())}
                className="shrink-0 rounded-lg px-3 py-2 text-sm font-semibold ring-1 ring-black/10 hover:bg-black/5">
                New one
              </button>
            </div>
            <span className="mt-1 block text-xs text-black/45">
              They change it themselves with "Forgot password?" on the sign-in screen.
            </span>
          </label>

          {takenBy && (
            <div className="rounded-xl bg-black/[0.04] p-3 text-sm">
              <p>{takenBy}</p>
              <p className="mt-1 text-black/60">
                It can be given the operator role instead — its existing password stays as it is.
              </p>
              <button disabled={busy} onClick={() => void create(true)}
                className="mt-2 rounded-xl bg-brand-charcoal px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                Use the existing account
              </button>
            </div>
          )}

          <button disabled={busy || !email.trim() || password.length < 10}
            onClick={() => void create(false)}
            className="rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-40">
            {busy ? 'Creating…' : 'Create the operator account'}
          </button>
        </div>
      )}

      {appointed && (
        <div className="mt-4 border-t border-black/5 pt-3">
          <p className="text-xs text-black/45">
            To hand the city to somebody who already has an account here, change who runs it
            without touching passwords:
          </p>
          <HandOver territory={territory} staff={staff} onDone={onCreated} />
        </div>
      )}
    </Card>
  );
}

/** Move the city to an existing account. No new login, no password involved. */
function HandOver({ territory, staff, onDone }: {
  territory: Territory; staff: StaffMember[]; onDone: () => void;
}) {
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const others = staff.filter((s) => s.id !== territory.operator_profile_id);
  if (others.length === 0) return null;

  return (
    <div className="mt-2">
      {error && <div className="mb-2"><ErrorNote msg={error} /></div>}
      <div className="flex flex-wrap gap-2">
        <select value={id} onChange={(e) => setId(e.target.value)}
          className="min-w-[14rem] flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm">
          <option value="">Choose an account</option>
          {others.map((s) => (
            <option key={s.id} value={s.id}>{s.full_name ?? s.id.slice(0, 8)} · {s.role}</option>
          ))}
        </select>
        <button disabled={busy || !id}
          onClick={() => {
            if (!supabase) return;
            setBusy(true); setError(null);
            void assignTerritoryOperator(supabase, territory.id, id)
              .then(onDone)
              .catch((e) => setError(errMessage(e)))
              .finally(() => setBusy(false));
          }}
          className="rounded-xl px-3 py-2 text-sm font-semibold ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-40">
          Hand it over
        </button>
      </div>
    </div>
  );
}
