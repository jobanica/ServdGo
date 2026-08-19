import { useEffect, useState } from 'react';
import {
  onAuthChange, onPasswordRecovery, sendPasswordReset, updatePassword,
  signInWithPassword, signUpWithPassword, ensureRider, signOut,
  uploadRiderDocument, riderDocumentsComplete, RIDER_DOCUMENT_LABELS, type RiderDocumentKind,
} from '@servdgo/supabase';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import { App } from './App.tsx';
import { REQUIRE_DOCUMENTS } from './config.ts';
import { errMessage } from '@servdgo/shared';

interface RiderRec {
  id: string;
  application_status: string;
  name?: string;
  orcr_doc: string | null;
  license_doc: string | null;
  proof_address_doc: string | null;
}
const DOC_KINDS: RiderDocumentKind[] = ['orcr', 'license', 'proof_address'];

/**
 * Rider auth + onboarding gate.
 *  - Preview mode (no backend): render the app with sample data.
 *  - Live: email magic-link sign-in → apply (name, phone, vehicle) → show
 *    status until an admin approves.
 */
export function RiderGate() {
  if (!isSupabaseConfigured || !supabase) return <App />;
  return <LiveGate />;
}

const inp = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/30';


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

const RIDER_COLS = 'id, application_status, name, orcr_doc, license_doc, proof_address_doc';

function LiveGate() {
  const [userId, setUserId] = useState<string | null | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [rider, setRider] = useState<RiderRec | null>(null);
  const [checked, setChecked] = useState(false);
  const [screen, setScreen] = useState<'landing' | 'auth'>('landing');
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  // Which button they pressed. 'join' means "I want to apply as a rider";
  // 'login' means "sign in to an existing account". Persists across the auth
  // event so signing up (Join) leads to the application, while signing in
  // (Login) to an account with no rider does NOT dump them into the form.
  const [intent, setIntent] = useState<'login' | 'join' | null>(null);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => onAuthChange(supabase!, (u) => {
    setUserId(u?.id ?? null);
    setEmail(u?.email ?? '');
    if (u) setScreen('landing'); // clear any stale auth form once signed in
  }), []);
  useEffect(() => onPasswordRecovery(supabase!, () => setRecovery(true)), []);

  async function loadRider(uid: string) {
    const { data } = await supabase!.from('riders').select(RIDER_COLS).eq('profile_id', uid).maybeSingle();
    setRider((data as RiderRec | null) ?? null);
    setChecked(true);
  }

  // Load this rider's application/status once signed in.
  useEffect(() => {
    if (!userId) { setRider(null); setChecked(false); return; }
    setChecked(false);
    void loadRider(userId);
  }, [userId]);

  const reload = () => userId ? loadRider(userId) : Promise.resolve();

  if (recovery) return <SetNewPassword onDone={() => setRecovery(false)} />;
  if (userId === undefined) {
    return <Shell title="Loading…" sub="Rider access"><p className="text-sm text-black/50">Please wait…</p></Shell>;
  }

  // Signed out: landing → login/create-account form.
  if (!userId) {
    if (screen === 'auth') return <EmailSignIn initialMode={authMode} onBack={() => setScreen('landing')} />;
    return <Landing onStart={(mode) => {
      setIntent(mode === 'signup' ? 'join' : 'login');
      setAuthMode(mode);
      setScreen('auth');
    }} />;
  }

  if (!checked) {
    return <Shell title="Loading…" sub="Rider access"><p className="text-sm text-black/50">Please wait…</p></Shell>;
  }

  // Signed in with an existing rider record → route by status.
  if (rider) {
    if (rider.application_status === 'rejected') return <StatusScreen status="rejected" />;
    // Documents are required before a rider can accept bookings — collect them
    // while the application is reviewed, and block entry if still missing.
    if (REQUIRE_DOCUMENTS && !riderDocumentsComplete(rider)) return <DocumentsGate rider={rider} onChange={reload} />;
    if (rider.application_status === 'approved') return <App riderId={rider.id} riderName={rider.name} />;
    return <StatusScreen status={rider.application_status} />;
  }

  // Signed in but no rider record yet. Only show the application when they came
  // in via "Join Us Now"; if they logged in, show the landing (with a signed-in
  // banner) so "Login" never lands straight on the apply form.
  if (intent === 'join') return <Onboard onDone={reload} />;
  return <Landing signedInEmail={email} onStart={async (mode) => {
    if (mode === 'signup') { setIntent('join'); }        // apply as a rider
    else {                                                // log in as a different account
      setIntent('login'); setAuthMode('signin'); setScreen('auth');
      await signOut(supabase!);
    }
  }} />;
}

/**
 * Verification documents step. A rider must upload their OR/CR, driver's
 * license, and proof of address before they can go online and accept bookings.
 * Shown after applying (while pending) and gates entry to the app.
 */
function DocumentsGate({ rider, onChange }: { rider: RiderRec; onChange: () => Promise<void> }) {
  const paths: Record<RiderDocumentKind, string | null> = {
    orcr: rider.orcr_doc, license: rider.license_doc, proof_address: rider.proof_address_doc,
  };
  const [busy, setBusy] = useState<RiderDocumentKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = riderDocumentsComplete(rider);

  async function upload(kind: RiderDocumentKind, file: File) {
    setBusy(kind); setError(null);
    try { await uploadRiderDocument(supabase!, kind, file); await onChange(); }
    catch (e) { setError(errMessage(e)); }
    finally { setBusy(null); }
  }

  return (
    <Shell title="Upload your documents" sub="Verification required">
      <p className="mb-4 text-sm text-black/60">
        Before you can accept bookings, please upload clear photos of the following.
      </p>
      <div className="space-y-3">
        {DOC_KINDS.map((k) => (
          <div key={k} className="flex items-center justify-between gap-3 rounded-lg border border-black/10 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{RIDER_DOCUMENT_LABELS[k]}</p>
              <p className={`text-xs ${paths[k] ? 'text-brand-green' : 'text-black/45'}`}>
                {busy === k ? 'Uploading…' : paths[k] ? '✓ Uploaded — tap to replace' : 'Not uploaded yet'}
              </p>
            </div>
            <label className="shrink-0 cursor-pointer rounded-lg bg-brand-green px-3 py-1.5 text-xs font-semibold text-white">
              {paths[k] ? 'Replace' : 'Upload'}
              <input type="file" accept="image/*,application/pdf" className="hidden" disabled={busy !== null}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(k, f); e.target.value = ''; }} />
            </label>
          </div>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <div className="mt-4 rounded-lg bg-brand-yellow/15 px-3 py-2 text-xs text-yellow-900">
        {done
          ? 'All documents uploaded. An admin will review your application — you can accept bookings once approved.'
          : 'Upload all three documents to continue.'}
      </div>
      <button onClick={() => void signOut(supabase!)} className="mt-3 w-full text-sm text-black/50">Sign out</button>
    </Shell>
  );
}

/** First-run welcome screen. */
function Landing({ onStart, signedInEmail }: { onStart: (mode: 'signin' | 'signup') => void; signedInEmail?: string }) {
  const [learn, setLearn] = useState(false);
  return (
    <div className="flex min-h-screen flex-col bg-[#f6f7f4]">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col px-6 pt-10">
        {signedInEmail && (
          <div className="mb-4 rounded-xl bg-brand-yellow/20 px-3 py-2 text-xs text-yellow-900">
            Signed in as <b>{signedInEmail}</b> — no rider account on this login yet.
            Tap <b>Join Us Now</b> to apply, or <b>Login</b> to use a different account.
          </div>
        )}
        <h1 className="text-4xl font-black leading-tight tracking-tight">
          Deliver faster,<br /><span className="text-brand-green">earn smarter</span>
        </h1>
        <p className="mt-3 text-sm text-black/55">
          Accept orders across your town and earn on your own schedule with ServdGo.
        </p>

        <div className="flex flex-1 items-center justify-center py-6">
          <div className="relative flex h-52 w-52 items-center justify-center rounded-full bg-gradient-to-br from-brand-green to-brand-purple shadow-xl">
            <span className="absolute -right-2 -top-1 h-16 w-16 rounded-full bg-brand-yellow/40 blur-xl" />
            <span className="text-[6rem] leading-none">🛵</span>
          </div>
        </div>

        {learn && (
          <div className="mb-4 rounded-2xl bg-white p-4 text-sm text-black/60 shadow-sm ring-1 ring-black/5">
            <p className="font-semibold text-brand-ink">How it works</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              <li>Sign in with your email, then apply with your name, phone, and vehicle.</li>
              <li>Once an admin approves you, go online to receive nearby orders.</li>
              <li>You keep the delivery &amp; convenience fees — a small commission is settled daily.</li>
            </ul>
          </div>
        )}

        <div className="space-y-3 pb-8">
          <button onClick={() => onStart('signin')}
            className="w-full rounded-2xl bg-brand-green py-3.5 font-bold text-white shadow-sm transition hover:brightness-95">
            Login &amp; Start Riding
          </button>
          <button onClick={() => onStart('signup')}
            className="w-full rounded-2xl bg-brand-purple py-3.5 font-bold text-white shadow-sm transition hover:brightness-95">
            Join Us Now
          </button>
          <button onClick={() => setLearn((v) => !v)}
            className="w-full rounded-2xl bg-white py-3.5 font-bold text-brand-ink ring-1 ring-black/10 transition hover:bg-black/[0.02]">
            {learn ? 'Hide details' : 'Learn More'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Shell({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="bg-brand-purple text-white">
        <div className="mx-auto max-w-sm px-5 py-4">
          <h1 className="text-lg font-bold">ServdGo Rider</h1>
          <p className="text-xs opacity-90">{sub}</p>
        </div>
      </header>
      <main className="mx-auto max-w-sm px-5 py-8">
        <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-black/5">
          <h2 className="mb-3 font-bold">{title}</h2>
          {children}
        </div>
      </main>
    </div>
  );
}

function EmailSignIn({ onBack, initialMode = 'signin' }: { onBack: () => void; initialMode?: 'signin' | 'signup' }) {
  const [mode, setMode] = useState<'signin' | 'signup' | 'forgot'>(initialMode);
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
        // Drop any leftover session so the reset applies to this email.
        await supabase!.auth.signOut().catch(() => {});
        await sendPasswordReset(supabase!, email.trim(), window.location.origin);
        setSent(true);
      }
      else {
        if (mode === 'signup') await signUpWithPassword(supabase!, email.trim(), password);
        else await signInWithPassword(supabase!, email.trim(), password);
        setRememberedEmail(remember ? email.trim() : null);
      }
      // onAuthChange in LiveGate takes over on success.
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'forgot') {
    return (
      <Shell title="Reset password" sub="Rider access">
        {sent ? (
          <>
            <p className="text-sm text-black/60">If an account exists for <b>{email.trim()}</b>, we've sent a reset link. Open it on this device to set a new password.</p>
            <button onClick={() => { setMode('signin'); setSent(false); }}
              className="mt-4 w-full rounded-lg border border-brand-purple py-2.5 text-sm font-medium text-brand-purple">Back to sign in</button>
          </>
        ) : (
          <>
            <button onClick={onBack} className="mb-3 text-sm font-medium text-brand-purple">← Back</button>
            <label className="mb-1 block text-sm font-medium text-black/70">Email</label>
            <input className={inp} value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com" inputMode="email" autoCapitalize="none" autoComplete="email"
              onKeyDown={(e) => { if (e.key === 'Enter' && valid && !busy) void submit(); }} />
            <button disabled={busy || !valid} onClick={submit}
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
    <Shell title={mode === 'signup' ? 'Create account' : 'Sign in'} sub="Rider access">
      <button onClick={onBack} className="mb-3 text-sm font-medium text-brand-purple">← Back</button>
      <label className="mb-1 block text-sm font-medium text-black/70">Email</label>
      <input className={inp} value={email} onChange={(e) => setEmail(e.target.value)}
        placeholder="you@email.com" inputMode="email" autoCapitalize="none" autoComplete="email" />
      <label className="mb-1 mt-3 block text-sm font-medium text-black/70">Password</label>
      <input className={inp} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
        placeholder="At least 6 characters"
        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
        onKeyDown={(e) => { if (e.key === 'Enter' && valid && !busy) void submit(); }} />
      <label className="mt-3 flex items-center gap-2 text-sm text-black/70">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)}
          className="h-4 w-4 accent-[#6DBE22]" />
        Remember me on this device
      </label>
      <button disabled={busy || !valid} onClick={submit}
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

/** Shown after the user opens a password-reset link. */
function SetNewPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Show whose password is about to change (guards against a leftover session).
  const [target, setTarget] = useState('');
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
    <Shell title="Set a new password" sub="Rider access">
      {target && <p className="mb-2 rounded-lg bg-brand-green/10 px-3 py-2 text-sm">for <b>{target}</b></p>}
      <label className="mb-1 block text-sm font-medium text-black/70">New password</label>
      <input className={inp} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
        placeholder="At least 6 characters" autoComplete="new-password"
        onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void save(); }} />
      <button disabled={busy} onClick={save}
        className="mt-4 w-full rounded-lg bg-brand-green py-3 font-semibold text-white disabled:opacity-60">
        {busy ? 'Saving…' : 'Save new password'}
      </button>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </Shell>
  );
}

function Onboard({ onDone }: { onDone: () => void | Promise<void> }) {
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    setBusy(true); setError(null);
    try { await ensureRider(supabase!, { name, mobile, vehicle }); await onDone(); }
    catch (e) { setError(errMessage(e)); setBusy(false); }
  }

  return (
    <Shell title="Apply as a rider" sub="Tell us about you">
      <div className="space-y-3">
        <input className={inp} placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={inp} placeholder="Mobile number" value={mobile} onChange={(e) => setMobile(e.target.value)} inputMode="tel" />
        <input className={inp} placeholder="Vehicle (e.g. motorcycle)" value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
      </div>
      <button disabled={busy || !name || !mobile} onClick={apply}
        className="mt-4 w-full rounded-lg bg-brand-green py-3 font-semibold text-white disabled:opacity-60">
        {busy ? 'Submitting…' : 'Submit application'}
      </button>
      <button onClick={() => void signOut(supabase!)} className="mt-2 w-full text-sm text-black/50">Sign out</button>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </Shell>
  );
}

function StatusScreen({ status }: { status: string }) {
  const rejected = status === 'rejected';
  return (
    <Shell title={rejected ? 'Application rejected' : 'Application pending'} sub="Onboarding">
      <p className="text-sm text-black/60">
        {rejected
          ? 'Your rider application was not approved. Contact the operator for details.'
          : 'Thanks for applying! An admin will review your application. You can accept orders once approved.'}
      </p>
      <button onClick={() => void signOut(supabase!)}
        className="mt-4 w-full rounded-lg border border-brand-purple py-2.5 text-sm font-medium text-brand-purple">
        Sign out
      </button>
    </Shell>
  );
}
