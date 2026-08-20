/**
 * Telling the diner something happened while they were not looking.
 *
 * The tracking page is the only thing the diner has — no account, no app, no
 * session. So the notification is the browser's own: permission asked on a real
 * tap, and posted through the service worker when there is one, which is what
 * lets it survive the tab being backgrounded on Android.
 *
 * Everything here is best-effort by design. A diner on a browser that refuses,
 * or who says no, still sees the page update; they just have to look at it.
 */

type N = typeof Notification;

const api = (): N | null => (globalThis as { Notification?: N }).Notification ?? null;

export type NotifyState = 'unsupported' | 'default' | 'granted' | 'denied';

export function notifyState(): NotifyState {
  const n = api();
  if (!n) return 'unsupported';
  return n.permission as NotifyState;
}

/** Must be called from a tap: browsers refuse the prompt outside a gesture. */
export async function askToNotify(): Promise<NotifyState> {
  const n = api();
  if (!n) return 'unsupported';
  if (n.permission !== 'default') return n.permission as NotifyState;
  try {
    return (await n.requestPermission()) as NotifyState;
  } catch {
    return 'denied';
  }
}

/**
 * Post one.
 *
 * Through the service worker where it exists — a plain `new Notification()` is
 * refused on Android Chrome, and quietly does nothing, which is the worst of
 * both. The tag collapses repeats, so a rider sending three messages leaves one
 * notification rather than three.
 */
export async function notify(title: string, body: string, tag: string): Promise<void> {
  const n = api();
  if (!n || n.permission !== 'granted') return;
  const options: NotificationOptions = {
    body,
    tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(title, { ...options, silent: false });
      return;
    }
  } catch { /* fall through to the direct constructor */ }
  try { new n(title, options); } catch { /* nothing more to try */ }
}
