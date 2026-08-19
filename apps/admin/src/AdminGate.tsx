import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { onAuthChange, onPasswordRecovery, sendPasswordReset, updatePassword, signOut } from '@servdgo/supabase';
import { isStaffRole, type StaffRole,
  errMessage,
} from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import { IconScooter } from './icons.tsx';

const RoleContext = createContext<StaffRole>('admin');
/** The signed-in staff member's role (defaults to admin in preview mode). */
export const useAdminRole = () => useContext(RoleContext);

/**
 * Admin sign-in gate. The admin console writes to RLS-protected tables, so it
 * needs an authenticated user whose profiles.role = 'admin'. Email + password
 * (no SMS provider needed). In preview mode the gate is bypassed.
 *
 * Provision the first admin once (see DEPLOYMENT.md):
 *   create the user (Dashboard → Auth), then
 *   update profiles set role='admin' where id = '<user-uuid>';
 */
export function AdminGate({ children }: { children: ReactNode }) {
  if (!isSupabaseConfigured || !supabase) {
    return <RoleContext.Provider value="admin">{children}</RoleContext.Provider>;
  }
  return <Gate>{children}</Gate>;
}

function Gate({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null | undefined>(undefined);
  const [role, setRole] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => onAuthChange(supabase!, (u) => setUserId(u?.id ?? null)), []);
  useEffect(() => onPasswordRecovery(supabase!, () => setRecovery(true)), []);
  useEffect(() => {
    if (!userId) { setRole(null); return; }
    supabase!.from('profiles').select('role').eq('id', userId).maybeSingle()
      .then(({ data }) => setRole(data?.role ?? 'customer'));
  }, [userId]);

  if (recovery) return <SetNewPassword onDone={() => setRecovery(false)} />;
  if (userId === undefined) return <Center>Loading…</Center>;
  if (!userId) return <SignIn />;
  if (role === null) return <Center>Checking access…</Center>;
  if (!isStaffRole(role)) return <NotAuthorized />;
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>;
}

function SignIn() {
  const [mode, setMode] = useState<'signin' | 'forgot'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (mode === 'forgot') {
        await sendPasswordReset(supabase!, email, window.location.origin);
        setSent(true);
      } else {
        const { error } = await supabase!.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'forgot') {
    return (
      <Shell>
        {sent ? (
          <>
            <p className="text-sm text-black/70">If an account exists for <b>{email}</b>, a password-reset link is on its way. Open it on this device to set a new password.</p>
            <button onClick={() => { setMode('signin'); setSent(false); }}
              className="mt-4 w-full rounded-lg border border-brand-charcoal py-2.5 text-sm font-medium text-brand-charcoal">Back to sign in</button>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <p className="text-sm text-black/60">Enter your email and we'll send a reset link.</p>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className={inp} />
            <button disabled={busy} className="w-full rounded-lg bg-brand-orange py-2.5 text-sm font-semibold text-white disabled:opacity-60">
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button type="button" onClick={() => { setMode('signin'); setError(null); }} className="w-full text-sm text-black/55">Back to sign in</button>
          </form>
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <form onSubmit={submit} className="space-y-3">
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="Email" className={inp} />
        <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder="Password" className={inp} />
        <button disabled={busy} className="w-full rounded-lg bg-brand-orange py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="button" onClick={() => { setMode('forgot'); setError(null); }} className="w-full text-sm text-brand-charcoal">Forgot password?</button>
      </form>
    </Shell>
  );
}

/** Shown after the user opens a password-reset link. */
function SetNewPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 6) { setError('Use at least 6 characters.'); return; }
    setBusy(true); setError(null);
    try { await updatePassword(supabase!, password); onDone(); }
    catch (err) { setError(errMessage(err)); setBusy(false); }
  }

  return (
    <Shell>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-black/70">Set a new password for your account.</p>
        <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder="New password (min 6 chars)" className={inp} autoComplete="new-password" />
        <button disabled={busy} className="w-full rounded-lg bg-brand-orange py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          {busy ? 'Saving…' : 'Save new password'}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    </Shell>
  );
}

function NotAuthorized() {
  return (
    <Shell>
      <p className="text-sm text-black/60">This account is not an admin. Ask the operator to grant access, then sign in again.</p>
      <button onClick={() => void signOut(supabase!)}
        className="mt-4 w-full rounded-lg border border-brand-charcoal py-2.5 text-sm font-medium text-brand-charcoal">
        Sign out
      </button>
    </Shell>
  );
}

const inp = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/30';

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f7f5f3] p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
        <div className="mb-4 flex items-center gap-2 font-extrabold text-lg text-brand-orange">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-orange text-white"><IconScooter /></span>
          ServdGo Admin
        </div>
        {children}
      </div>
    </div>
  );
}

const Center = ({ children }: { children: ReactNode }) =>
  <div className="flex min-h-screen items-center justify-center text-sm text-black/50">{children}</div>;
