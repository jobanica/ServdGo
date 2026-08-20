/**
 * A message on any live delivery, not just the one that happens to be open.
 *
 * The chat already had realtime and an unread badge, but only inside the card
 * for that delivery — so a rider looking at their queue, or at nothing, learned
 * about a message when they next happened to tap. This subscribes across every
 * active order at once and makes noise.
 *
 * The push notification (0122 → notify-message) covers the app being closed.
 * This covers it being open, which is most of a shift, and it arrives instantly
 * rather than by way of Google.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeOrderMessages, type OrderMessage } from '@servdgo/supabase';
import { supabase } from './lib/supabase.ts';
import { playMessageAlert } from './alert.ts';

export interface IncomingMessage {
  orderId: string;
  body: string;
  at: string;
}

/** Ask once, quietly. A rider who says no is never asked again by us. */
function notify(title: string, body: string, tag: string): void {
  try {
    const N = (globalThis as { Notification?: typeof Notification }).Notification;
    if (!N || N.permission !== 'granted') return;
    new N(title, { body, tag, icon: '/icons/icon-192.png' });
  } catch { /* the sound and the banner remain */ }
}

export function useMessageAlert(orderIds: readonly string[]): {
  latest: IncomingMessage | null;
  dismiss: () => void;
} {
  const [latest, setLatest] = useState<IncomingMessage | null>(null);
  const key = [...orderIds].sort().join(',');
  // The subscription is rebuilt whenever the set of live orders changes, so the
  // handler is held in a ref rather than in the dependency list — otherwise
  // every render tears down four channels and opens them again.
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!supabase || !key) return;
    const ids = key.split(',');
    const unsubs = ids.map((id) =>
      subscribeOrderMessages(supabase!, id, (m: OrderMessage) => {
        if (m.sender_role === 'rider') return;      // our own words
        if (seen.current.has(m.id)) return;
        seen.current.add(m.id);
        const body = (m.body ?? '').trim() || (m.image_url ? 'Sent a photo' : '');
        playMessageAlert();
        notify('Message from your customer', body || 'Tap to read', `order-${id}`);
        setLatest({ orderId: id, body, at: m.created_at });
      }, 'rider-alert'),
    );
    return () => { for (const off of unsubs) off(); };
  }, [key]);

  const dismiss = useCallback(() => setLatest(null), []);
  return { latest, dismiss };
}

/**
 * Ask for permission to post notifications, on a real tap.
 *
 * Browsers refuse the prompt outside a gesture, and a prompt on first paint is
 * one a rider dismisses without reading. This is called from the same place
 * the alert sound is armed.
 */
export function requestNotificationPermission(): void {
  try {
    const N = (globalThis as { Notification?: typeof Notification }).Notification;
    if (N && N.permission === 'default') void N.requestPermission();
  } catch { /* not available; nothing lost */ }
}
