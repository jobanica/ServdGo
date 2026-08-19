import { useEffect, useRef, useState } from 'react';

/**
 * "Your rider is outside."
 *
 * Fires the moment `arrived_at` flips from empty to set: a banner in the app,
 * plus a real system notification and a buzz so it lands even when the phone is
 * in a pocket with the screen off.
 *
 * Limits worth knowing: the browser only lets us raise a notification while the
 * page is alive (open, or backgrounded). If the customer has fully closed the
 * app, this cannot reach them — that needs server-sent Web Push, which is a
 * separate piece of plumbing.
 */
export function useArrivalAlert(arrivedAt: string | null | undefined, riderName?: string | null) {
  const announced = useRef(false);

  useEffect(() => {
    if (!arrivedAt || announced.current) return;
    announced.current = true;

    const title = 'Your rider is outside 🛵';
    const body = `${riderName || 'Your rider'} is at your address with your order.`;

    try { navigator.vibrate?.([200, 100, 200, 100, 400]); } catch { /* unsupported */ }

    if (typeof Notification === 'undefined') return;
    const show = () => {
      try {
        // Go through the service worker when there is one: notifications raised
        // that way survive the tab being backgrounded on Android.
        void navigator.serviceWorker?.getRegistration().then((reg) => {
          if (reg) void reg.showNotification(title, { body, icon: '/icons/icon-192.png', tag: 'ebd-arrival' });
          else new Notification(title, { body, icon: '/icons/icon-192.png' });
        }).catch(() => { new Notification(title, { body }); });
      } catch { /* notifications unavailable */ }
    };
    if (Notification.permission === 'granted') show();
    else if (Notification.permission !== 'denied') void Notification.requestPermission().then((p) => { if (p === 'granted') show(); });
  }, [arrivedAt, riderName]);
}

/**
 * Asks for notification permission up front, while the order is still on the
 * way — being asked at the moment the rider arrives is too late to be useful.
 */
export function NotificationOptIn({ show }: { show: boolean }) {
  const [state, setState] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  if (!show || state !== 'default') return null;
  return (
    <button
      onClick={() => { void Notification.requestPermission().then(setState); }}
      className="w-full rounded-xl bg-brand-purple/[0.08] px-3 py-2.5 text-left text-xs font-medium text-brand-purple ring-1 ring-brand-purple/20">
      🔔 Turn on alerts so we can tell you the moment your rider is outside.
    </button>
  );
}

/** The banner itself, shown until the order completes. */
export function ArrivalBanner({ arrivedAt, riderName }: { arrivedAt: string | null; riderName?: string | null }) {
  if (!arrivedAt) return null;
  return (
    <div className="animate-pulse-none rounded-xl bg-brand-green/15 p-4 ring-2 ring-brand-green">
      <p className="text-base font-extrabold text-green-800">🛵 Your rider is outside!</p>
      <p className="mt-0.5 text-sm text-green-900/80">
        {riderName || 'Your rider'} is at your address with your order — please come out when you can.
      </p>
      <p className="mt-1 text-[11px] text-green-900/60">
        Arrived {new Date(arrivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </p>
    </div>
  );
}
