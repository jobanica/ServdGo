import { useEffect, useState } from 'react';
import { countAudience, type BroadcastAudience } from '@servdgo/supabase';
import { smsSegments,
  errMessage,
} from '@servdgo/shared';
import { supabase } from './lib/supabase.ts';
import { Card } from './ui.tsx';

const AUDIENCES: { key: BroadcastAudience; label: string }[] = [
  { key: 'customers', label: 'All customers' },
  { key: 'riders', label: 'Approved riders' },
  { key: 'stores', label: 'Stores (with a number)' },
];

export function Broadcast() {
  const [message, setMessage] = useState('');
  const [audience, setAudience] = useState<BroadcastAudience>('customers');
  const [count, setCount] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCount(null);
    if (!supabase) { setCount(audience === 'customers' ? 12 : audience === 'riders' ? 4 : 3); return; }
    countAudience(supabase, audience).then(setCount).catch(() => setCount(null));
  }, [audience]);

  const segments = smsSegments(message || ' ');

  async function send() {
    if (!supabase) { setError('Connect Supabase and deploy the broadcast-sms function to send.'); return; }
    setSending(true); setError(null); setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke('broadcast-sms', {
        body: { message, audience },
      });
      if (error) throw error;
      setResult(`Sent to ${(data as { recipients?: number })?.recipients ?? count} recipient(s).`);
      setMessage('');
    } catch (e) {
      setError(errMessage(e));
    } finally { setSending(false); }
  }

  return (
    <div className="max-w-2xl space-y-5">
      <Card title="Compose broadcast">
        <textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)}
          placeholder="e.g. We're open! Order food, Pabili and Padala now."
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/30" />
        <div className="mt-1 flex justify-between text-xs text-black/50">
          <span>{message.length} chars</span>
          <span>{segments} SMS segment{segments > 1 ? 's' : ''} × recipient</span>
        </div>

        <p className="mb-2 mt-4 text-sm font-medium text-black/70">Audience</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {AUDIENCES.map((a) => (
            <button key={a.key} onClick={() => setAudience(a.key)}
              className={`rounded-lg px-3 py-2 text-sm font-medium ring-1 transition ${
                audience === a.key ? 'bg-brand-green text-white ring-brand-green' : 'bg-white text-black/60 ring-black/10'
              }`}>
              {a.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-sm text-black/60">
          Recipients: <span className="font-semibold">{count ?? '…'}</span>
          {count != null && <span className="text-black/40"> · ~{count * segments} segments total</span>}
        </p>
      </Card>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {result && <p className="rounded-lg bg-brand-green/10 px-3 py-2 text-sm text-green-800">✓ {result}</p>}

      <div className="flex items-center gap-3">
        <button onClick={send} disabled={sending || message.trim().length < 3 || !count}
          className="rounded-lg bg-brand-green px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          {sending ? 'Sending…' : `Send to ${count ?? 0} recipient(s)`}
        </button>
        <span className="text-xs text-black/40">Respect opt-out/consent before broadcasting to customers.</span>
      </div>
    </div>
  );
}
