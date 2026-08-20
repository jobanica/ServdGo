/**
 * The payment account riders top up through.
 *
 * The secret key is write-only here, and that is deliberate rather than
 * awkward: it goes into Vault through a function that only the franchisor may
 * call, and the only way back out is granted to the two edge functions that
 * spend it. So this screen can tell you a key is stored, which one it is by its
 * last four characters, and when it was set — and it cannot show you the key,
 * not even to the person who typed it.
 *
 * Leaving a secret field blank keeps whatever is already stored, so switching
 * from test to live does not mean retyping a key nobody can read to check.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  xenditStatus, saveXendit, disconnectXendit, testXendit,
  type XenditStatus, type XenditTestResult,
} from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured, functionsBaseUrl } from '../lib/supabase.ts';
import { Card, Muted, ErrorNote, Toggle } from '../ui.tsx';

const inp = 'mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/30';

const Field = ({ label, hint, children }:
  { label: string; hint?: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="text-xs font-semibold uppercase tracking-wide text-black/40">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-xs text-black/45">{hint}</span>}
  </label>
);

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <span className="text-xs font-semibold uppercase tracking-wide text-black/40">{label}</span>
      <div className="mt-1 flex items-stretch gap-2">
        <code className="flex-1 truncate rounded-lg bg-black/[0.04] px-3 py-2 text-xs">{value}</code>
        <button
          onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="rounded-lg bg-black/[0.06] px-3 text-xs font-bold">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function Xendit() {
  const [status, setStatus] = useState<XenditStatus | null>(null);
  const [key, setKey] = useState('');
  const [token, setToken] = useState('');
  const [mode, setMode] = useState<'test' | 'live'>('test');
  const [successUrl, setSuccessUrl] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [result, setResult] = useState<XenditTestResult | null>(null);

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    try {
      const s = await xenditStatus(supabase);
      setStatus(s);
      setMode(s.mode);
      setSuccessUrl(s.successUrl ?? '');
      setMinutes(Math.round(s.invoiceDuration / 60));
    } catch (e) { setError(errMessage(e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!isSupabaseConfigured) {
    return <Card title="Xendit"><Muted>Connect Supabase to set up payments.</Muted></Card>;
  }
  if (!status) return <Card title="Xendit"><Muted>Loading…</Muted></Card>;

  const webhookUrl = functionsBaseUrl ? `${functionsBaseUrl}/xendit-webhook` : '(set VITE_SUPABASE_URL)';
  const ready = status.keySet && status.callbackSet;

  async function run(fn: () => Promise<XenditStatus>, msg: string) {
    setBusy(true); setError(null); setNote(null); setResult(null);
    try {
      setStatus(await fn());
      setKey(''); setToken('');
      setNote(msg);
    } catch (e) { setError(errMessage(e)); } finally { setBusy(false); }
  }

  async function test() {
    if (!supabase) return;
    setBusy(true); setError(null); setNote(null);
    try { setResult(await testXendit(supabase)); }
    catch (e) { setError(errMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Card title="Xendit — rider top-ups">
      <p className="mb-4 max-w-2xl text-sm text-black/55">
        Where the money goes when a rider tops up. This is your Xendit account,
        so every top-up lands with you and each city is paid its share from the
        Operator payouts screen.
      </p>

      {!status.vaultAvailable && (
        <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          This database has no Vault, so there is nowhere safe to keep a payment key.
          Set <code>XENDIT_SECRET_KEY</code> and <code>XENDIT_CALLBACK_TOKEN</code> as
          edge-function secrets instead.
        </p>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${
          ready ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
          {ready ? 'Connected' : status.keySet ? 'Key set, no callback token' : 'Not connected'}
        </span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${
          status.mode === 'live' ? 'bg-black text-white' : 'bg-black/[0.06] text-black/60'}`}>
          {status.mode === 'live' ? 'Live' : 'Test'}
        </span>
        {status.keyHint && (
          <span className="text-xs text-black/45">
            key ••••{status.keyHint}
            {status.keySetAt && ` · set ${new Date(status.keySetAt).toLocaleDateString()}`}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Toggle on={status.enabled} disabled={busy || !ready}
          onChange={(on) => void run(() => saveXendit(supabase!, { enabled: on }),
            on ? 'Card and e-wallet top-ups are on' : 'Card and e-wallet top-ups are off')} />
        <span className="text-sm font-semibold">
          {status.enabled ? 'Riders can top up in the app' : 'Riders top up at the city office only'}
        </span>
      </div>
      {!ready && (
        <p className="mt-1 text-xs text-black/45">
          Store a secret key and a callback token before you switch this on.
        </p>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Secret key"
          hint={status.keySet ? 'Stored. Leave blank to keep it.' : 'Xendit → Settings → API keys → Secret key.'}>
          <input type="password" autoComplete="off" className={inp}
            placeholder={status.keySet ? `••••••••••••${status.keyHint ?? ''}` : 'xnd_production_… or xnd_development_…'}
            value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field label="Callback verification token"
          hint={status.callbackSet
            ? `Stored${status.callbackSetAt ? ` on ${new Date(status.callbackSetAt).toLocaleDateString()}` : ''}. Leave blank to keep it.`
            : 'Xendit → Settings → Webhooks → Verification token.'}>
          <input type="password" autoComplete="off" className={inp}
            placeholder={status.callbackSet ? '••••••••••••' : 'The token Xendit shows you'}
            value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <Field label="Environment" hint="Recorded, so a test key running in production is visible.">
          <select className={inp} value={mode} onChange={(e) => setMode(e.target.value as 'test' | 'live')}>
            <option value="test">Test</option>
            <option value="live">Live</option>
          </select>
        </Field>
        <Field label="Payment page expires after" hint="Minutes. The rider can always start another.">
          <input type="number" min={5} max={1440} className={inp} value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Send the rider back to"
            hint="Optional. Where Xendit returns them after paying — https only.">
            <input className={inp} placeholder="https://servdgo-rider.vercel.app"
              value={successUrl} onChange={(e) => setSuccessUrl(e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button disabled={busy}
          onClick={() => void run(() => saveXendit(supabase!, {
            secretKey: key.trim() || undefined,
            callbackToken: token.trim() || undefined,
            mode,
            successUrl: successUrl.trim() || undefined,
            invoiceDuration: Math.round(minutes * 60),
          }), 'Saved')}
          className="rounded-xl bg-brand-orange px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Save
        </button>
        <button disabled={busy || !status.keySet} onClick={() => void test()}
          className="rounded-xl bg-black/[0.06] px-3 py-2 text-sm font-semibold disabled:opacity-50">
          Test connection
        </button>
        {status.keySet && (
          <button disabled={busy}
            onClick={() => { if (confirm('Forget the stored Xendit key and token?')) void run(() => disconnectXendit(supabase!), 'Disconnected'); }}
            className="rounded-xl px-3 py-2 text-sm font-semibold text-red-600 disabled:opacity-50">
            Disconnect
          </button>
        )}
      </div>

      {error && <div className="mt-3"><ErrorNote msg={error} /></div>}
      {note && <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">{note}</p>}
      {result && (
        <div className={`mt-3 rounded-lg px-3 py-2 text-sm ring-1 ${
          result.ok ? 'bg-green-50 text-green-800 ring-green-200' : 'bg-red-50 text-red-800 ring-red-200'}`}>
          {result.ok ? (
            <>
              <p className="font-semibold">Xendit accepted the key.</p>
              {result.modeMismatch && (
                <p className="mt-1">
                  It is a {result.keyIsProduction ? 'production' : 'development'} key but this is
                  set to {result.mode}. One of the two is wrong.
                </p>
              )}
              {!result.callbackTokenSet && (
                <p className="mt-1">No callback token is stored, so paid top-ups will never be credited.</p>
              )}
              {typeof result.balance === 'number' && (
                <p className="mt-1 text-xs">Account balance ₱{result.balance.toFixed(2)}.</p>
              )}
            </>
          ) : (
            <p>{result.message ?? 'That did not work.'}</p>
          )}
        </div>
      )}

      <div className="mt-6 rounded-xl bg-black/[0.03] p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-black/40">Point Xendit back at us</p>
        <p className="mt-1 mb-3 text-sm text-black/55">
          In Xendit → Settings → Webhooks, set <strong>Invoices paid</strong> and{' '}
          <strong>Invoices expired</strong> to this URL. Without it a rider's money
          arrives and their balance never moves.
        </p>
        <CopyRow label="Webhook URL" value={webhookUrl} />
      </div>
    </Card>
  );
}
