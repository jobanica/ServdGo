import { useEffect, useState, type ReactNode } from 'react';
import { signInWithPassword, signUpWithPassword, sendPasswordReset, updatePassword, onPasswordRecovery } from '@ebd/supabase';
import { supabase } from '../lib/supabase.ts';
import { FirstAddressForm } from '../AddressChooser.tsx';
import { useAuth } from './AuthContext.tsx';
import { inputCls } from '../ui.tsx';
import { REQUIRE_ACCOUNT } from '../config.ts';
import { errMessage } from '@ebd/shared';

/**
 * Account gate. With REQUIRE_ACCOUNT on, a customer must sign in with their
 * email (magic link) and add a phone number before they can order. Preview mode
 * (`live` false) renders children directly.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { live, loading, authed, needsPhone, needsAddress } = useAuth();
  const [recovery, setRecovery] = useState(false);
  useEffect(() => { if (!supabase) return; return onPasswordRecovery(supabase, () => setRecovery(true)); }, []);
  if (!REQUIRE_ACCOUNT || !live) return <>{children}</>;
  if (recovery) return <SetNewPassword onDone={() => setRecovery(false)} />;
  if (loading) return <Splash sub="Loading…" />;
  if (!authed) return <EmailSignIn />;
  if (needsPhone) return <PhoneSetup />;
  // The address is the last thing onboarding asks for, and the reason ordering
  // never has to open a map again.
  if (needsAddress) return <AddressSetup />;
  return <>{children}</>;
}


// Remember the last email used to sign in, so returning users only need their
// password. The password itself is deliberately never stored — the device's own
// password manager handles that safely via the autocomplete attributes below.
const REMEMBER_KEY = 'ebd:remember-email';
const rememberedEmail = () => {
  try { return localStorage.getItem(REMEMBER_KEY) ?? ''; } catch { return ''; }
};
const setRememberedEmail = (email: string | null) => {
  try {
    if (email) localStorage.setItem(REMEMBER_KEY, email);
    else localStorage.removeItem(REMEMBER_KEY);
  } catch { /* storage unavailable — sign-in still works */ }
};

/** Shown after the user opens a password-reset link. */
function SetNewPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Show whose password is about to change, so a leftover session can't cause
  // the wrong account to be updated without the user noticing.
  const [target, setTarget] = useState<string>('');
  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => setTarget(data.session?.user.email ?? ''));
  }, []);

  async function save() {
    if (password.length < 6) { setError('Use at least 6 characters.'); return; }
    setBusy(true); setError(null);
    try { await updatePassword(supabase!, password); onDone(); }
    catch (e) { setError(errMessage(e)); setBusy(false); }
  }

  return (
    <Shell title="Set a new password">
      {target && <p className="mb-2 rounded-lg bg-brand-green/10 px-3 py-2 text-sm">for <b>{target}</b></p>}
      <label className="mb-1 block text-sm font-medium text-black/70">New password</label>
      <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
        placeholder="At least 6 characters" autoComplete="new-password"
        onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void save(); }} />
      <button onClick={save} disabled={busy}
        className="mt-4 w-full rounded-lg bg-brand-green py-3 font-semibold text-white disabled:opacity-60">
        {busy ? 'Saving…' : 'Save new password'}
      </button>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </Shell>
  );
}

/**
 * Branded entry layout — the first screen a customer sees. A deep-green hero
 * carries the brand and the value proposition; the form sits in a white card
 * that overlaps it, with the service line-up and trust points underneath.
 */
function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-[#f4f6f3]">
      {/* Hero */}
      <header className="relative overflow-hidden bg-brand-green pb-20 pt-10 text-white">
        <div className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(120% 90% at 50% -10%, #86d33e 0%, #6DBE22 45%, #4d9417 100%)' }} />
        <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-white/10" />
        <div className="pointer-events-none absolute -left-20 top-24 h-48 w-48 rounded-full bg-black/5" />

        <div className="relative mx-auto w-full max-w-md px-6 text-center">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-white/95 p-2 shadow-lg ring-4 ring-white/20">
            <img src="/icons/pwa-512x512.png" alt="Easy Buy Delivery" className="h-full w-full object-contain" />
          </span>
          <h1 className="mt-4 text-3xl font-black leading-tight tracking-tight">Easy Buy Delivery</h1>
          <p className="mt-1.5 text-sm text-white/85">
            Food, errands and parcels — delivered across your town by one trusted rider.
          </p>
          <div className="mt-4 flex justify-center gap-2 text-[11px] font-semibold">
            {['🍽️ Food', '🛒 Pabili', '📦 Padala'].map((s) => (
              <span key={s} className="rounded-full bg-white/15 px-3 py-1 ring-1 ring-white/25">{s}</span>
            ))}
          </div>
        </div>
      </header>

      {/* Form card, overlapping the hero */}
      <main className="relative z-10 mx-auto -mt-14 w-full max-w-md flex-1 px-5 pb-10">
        <div className="rounded-3xl bg-white p-6 shadow-xl ring-1 ring-black/5">
          <h2 className="mb-4 text-lg font-extrabold text-brand-ink">{title}</h2>
          {children}
        </div>

        {/* Trust points */}
        <div className="mt-6 grid grid-cols-3 gap-3 text-center">
          {[
            { icon: '📍', label: 'Live tracking' },
            { icon: '💸', label: 'Cash or GCash' },
            { icon: '⚡', label: 'Fast local riders' },
          ].map((f) => (
            <div key={f.label} className="rounded-2xl bg-white/70 px-2 py-3 ring-1 ring-black/5">
              <div className="text-lg">{f.icon}</div>
              <p className="mt-1 text-[11px] font-semibold leading-tight text-black/60">{f.label}</p>
            </div>
          ))}
        </div>

        <p className="mt-6 text-center text-[11px] text-black/35">
          © {new Date().getFullYear()} Easy Buy Delivery
        </p>
      </main>
    </div>
  );
}

const Splash = ({ sub }: { sub: string }) => <Shell title={sub}><p className="text-sm text-black/50">Please wait…</p></Shell>;

function EmailSignIn() {
  const [mode, setMode] = useState<'signin' | 'signup' | 'forgot'>('signin');
  const [email, setEmail] = useState(rememberedEmail);
  const [remember, setRemember] = useState(true);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const emailOk = /\S+@\S+\.\S+/.test(email.trim());
  const valid = mode === 'forgot' ? emailOk : emailOk && password.length >= 6;

  async function submit() {
    setError(null); setBusy(true);
    try {
      if (mode === 'forgot') {
        // Drop any leftover session first so the reset link applies to this email.
        await supabase!.auth.signOut().catch(() => {});
        await sendPasswordReset(supabase!, email.trim(), window.location.origin);
        setSent(true);
      }
      else {
        if (mode === 'signup') await signUpWithPassword(supabase!, email.trim(), password);
        else await signInWithPassword(supabase!, email.trim(), password);
        setRememberedEmail(remember ? email.trim() : null);
      }
      // The auth listener in AuthContext takes over on success.
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'forgot') {
    return (
      <Shell title="Reset your password">
        {sent ? (
          <>
            <p className="text-sm text-black/60">If an account exists for <b>{email.trim()}</b>, we've sent a reset link. Open it on this device to set a new password.</p>
            <button onClick={() => { setMode('signin'); setSent(false); }}
              className="mt-4 w-full rounded-lg border border-brand-purple py-2.5 text-sm font-medium text-brand-purple">Back to sign in</button>
          </>
        ) : (
          <>
            <label className="mb-1 block text-sm font-medium text-black/70">Email</label>
            <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com" inputMode="email" autoCapitalize="none" autoComplete="email"
              onKeyDown={(e) => { if (e.key === 'Enter' && valid && !busy) void submit(); }} />
            <button onClick={submit} disabled={busy || !valid}
              className="mt-4 w-full rounded-lg bg-brand-green py-3 font-semibold text-white disabled:opacity-60">
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <button onClick={() => { setMode('signin'); setError(null); }} className="mt-4 w-full text-sm text-black/55">Back to sign in</button>
          </>
        )}
      </Shell>
    );
  }

  return (
    <Shell title={mode === 'signup' ? 'Create your account' : 'Sign in to order'}>
      <label className="mb-1 block text-sm font-medium text-black/70">Email</label>
      <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)}
        placeholder="you@email.com" inputMode="email" autoCapitalize="none" autoComplete="email" />
      <label className="mb-1 mt-3 block text-sm font-medium text-black/70">Password</label>
      <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
        placeholder="At least 6 characters"
        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
        onKeyDown={(e) => { if (e.key === 'Enter' && valid && !busy) void submit(); }} />
      <label className="mt-3 flex items-center gap-2 text-sm text-black/70">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)}
          className="h-4 w-4 accent-[#6DBE22]" />
        Remember me on this device
      </label>
      <button onClick={submit} disabled={busy || !valid}
        className="mt-3 w-full rounded-lg bg-brand-green py-3 font-semibold text-white disabled:opacity-60">
        {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
      </button>
      {mode === 'signin' && (
        <button onClick={() => { setMode('forgot'); setError(null); }} className="mt-3 w-full text-sm text-brand-purple">Forgot password?</button>
      )}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <button onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setError(null); }}
        className="mt-4 w-full text-sm text-black/55">
        {mode === 'signup' ? 'Already have an account? Sign in' : "New here? Create an account"}
      </button>
    </Shell>
  );
}

/** Step two of onboarding: where deliveries go by default. */
function AddressSetup() {
  const { customerId, refresh, signOut, name, mobile } = useAuth();
  if (!customerId) return <Splash sub="Loading…" />;
  return (
    <Shell title="Where do we deliver?">
      <h2 className="text-lg font-bold">Set your delivery address</h2>
      <p className="mb-3 mt-1 text-sm text-black/60">
        Pin it once and every order goes here by default — no map to fiddle with at checkout.
      </p>
      <FirstAddressForm customerId={customerId} onSaved={refresh}
        defaultName={name} defaultPhone={mobile} />
      <button onClick={() => void signOut()} className="mt-3 w-full text-sm text-black/50">Sign out</button>
    </Shell>
  );
}

function PhoneSetup() {
  const { ensureContact, signOut, email } = useAuth();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    // The rider has to ask for someone at the door; "no name given" is not an
    // answer, so this is required rather than a nicety.
    if (name.trim().length < 2) { setError('Please enter your name — your rider needs to know who to hand the order to.'); return; }
    if (phone.trim().length < 7) { setError('Enter a valid mobile number.'); return; }
    setBusy(true); setError(null);
    try { await ensureContact(phone.trim(), name.trim() || undefined); }
    catch (e) { setError(errMessage(e)); setBusy(false); }
  }

  return (
    <Shell title="One more step">
      <h2 className="text-lg font-bold">Add your phone number</h2>
      <p className="mt-1 text-sm text-black/60">Signed in as {email}. Your rider needs a name to ask for and a number to reach you on.</p>
      <label className="mb-1 mt-4 block text-sm font-medium text-black/70">Your name <span className="text-red-500">*</span></label>
      <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Juan Dela Cruz" required />
      <label className="mb-1 mt-3 block text-sm font-medium text-black/70">Mobile number <span className="text-red-500">*</span></label>
      <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0917 123 4567" inputMode="tel" />
      <button onClick={save} disabled={busy || name.trim().length < 2 || phone.trim().length < 7}
        className="mt-4 w-full rounded-lg bg-brand-green py-3 font-semibold text-white disabled:opacity-60">
        {busy ? 'Saving…' : 'Save & continue'}
      </button>
      <button onClick={() => void signOut()} className="mt-2 w-full text-sm text-black/50">Sign out</button>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </Shell>
  );
}
