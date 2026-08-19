import { useEffect, useRef, useState } from 'react';
import { listOrderMessages, sendOrderMessage, uploadChatPhoto, subscribeOrderMessages, type OrderMessage } from '@servdgo/supabase';
import { supabase } from './lib/supabase.ts';

/** A button that opens the order chat and shows an unread-message badge. */
export function ChatButton({ orderId, role, title, className }: {
  orderId: string; role: 'customer' | 'rider'; title: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    listOrderMessages(supabase, orderId)
      .then((ms) => { if (alive) setUnread(ms.filter((m) => m.sender_role !== role).length); })
      .catch(() => {});
    const unsub = subscribeOrderMessages(supabase, orderId, (m) => {
      if (m.sender_role !== role) setUnread((n) => n + 1);
    }, 'chat-badge');
    return () => { alive = false; unsub(); };
  }, [orderId, role]);

  return (
    <>
      <button onClick={() => { setOpen(true); setUnread(0); }}
        className={className ?? 'relative w-full rounded-xl bg-brand-charcoal py-3 text-sm font-bold text-white shadow-sm'}>
        💬 {title}
        {unread > 0 && (
          <span className="ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-white px-1.5 text-xs font-bold text-brand-charcoal">
            {unread}
          </span>
        )}
      </button>
      {open && <Chat orderId={orderId} role={role} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Order chat overlay. `role` is who the current user is on this order. */
export function Chat({ orderId, role, title, onClose }: {
  orderId: string; role: 'customer' | 'rider'; title: string; onClose: () => void;
}) {
  const [msgs, setMsgs] = useState<OrderMessage[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    listOrderMessages(supabase, orderId).then((m) => { if (alive) setMsgs(m); }).catch(() => {});
    const unsub = subscribeOrderMessages(supabase, orderId, (m) =>
      setMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m])));
    return () => { alive = false; unsub(); };
  }, [orderId]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs.length]);

  async function send() {
    const t = text.trim();
    if (!t || !supabase) return;
    setText(''); setBusy(true);
    try { await sendOrderMessage(supabase, orderId, role, t); }
    catch { setText(t); }
    finally { setBusy(false); }
  }

  /** A photo can carry the whole message — send it with whatever was typed. */
  async function sendPhoto(file: File) {
    if (!supabase) return;
    setBusy(true); setErr(null);
    const caption = text.trim();
    try {
      const url = await uploadChatPhoto(supabase, orderId, file);
      await sendOrderMessage(supabase, orderId, role, caption, url);
      setText('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send that photo.');
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[10000] flex flex-col justify-end bg-black/40 sm:items-center sm:justify-center sm:p-4" onClick={onClose}>
      <div className="flex h-[75vh] w-full max-w-md flex-col rounded-t-2xl bg-white sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-black/5 px-4 py-3">
          <h3 className="font-bold">{title}</h3>
          <button onClick={onClose} className="text-sm text-brand-charcoal">Close</button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {msgs.length === 0 && <p className="mt-6 text-center text-sm text-black/40">No messages yet. Say hi 👋</p>}
          {msgs.map((m) => {
            const mine = m.sender_role === role;
            return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <span className={`max-w-[78%] overflow-hidden rounded-2xl text-sm ${mine ? 'bg-brand-orange text-white' : 'bg-black/[0.06] text-black'}`}>
                  {m.image_url && (
                    <a href={m.image_url} target="_blank" rel="noreferrer" className="block">
                      <img src={m.image_url} alt="Shared photo" className="max-h-64 w-full object-cover" />
                    </a>
                  )}
                  {m.body && <span className="block px-3 py-2">{m.body}</span>}
                </span>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
        {err && <p className="px-3 pb-1 text-xs text-red-600">{err}</p>}
        <div className="flex items-center gap-2 border-t border-black/5 p-3">
          <label aria-label="Take a photo"
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-black/[0.06] text-base">
            📷
            <input type="file" accept="image/*" capture="environment" className="hidden" disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void sendPhoto(f); e.target.value = ''; }} />
          </label>
          <label aria-label="Attach a photo"
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-black/[0.06] text-base">
            📎
            <input type="file" accept="image/*" className="hidden" disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void sendPhoto(f); e.target.value = ''; }} />
          </label>
          <input value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
            placeholder="Message…"
            className="min-w-0 flex-1 rounded-full border border-black/10 px-4 py-2 text-sm outline-none focus:border-brand-orange" />
          <button onClick={send} disabled={busy || !text.trim()}
            className="shrink-0 rounded-full bg-brand-orange px-4 text-sm font-semibold text-white disabled:opacity-50">Send</button>
        </div>
      </div>
    </div>
  );
}
