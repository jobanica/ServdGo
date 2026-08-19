import { useEffect, useState } from 'react';
import { isInstalledApp } from '@servdgo/supabase';
import { isInAppBrowser, inAppBrowserName, isAndroid, openInChrome } from './inAppBrowser.tsx';
import { isIOS } from './geo.ts';

/**
 * The Chrome/Android install event, which the browser fires at most once and
 * only when it judges the app installable. Capturing it is the only way to show
 * an install button at a moment of our choosing rather than Chrome's.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const SNOOZE_KEY = 'ebd.customer.installSnoozedUntil';
const SNOOZE_DAYS = 14;

function snoozed(): boolean {
  try {
    const until = Number(localStorage.getItem(SNOOZE_KEY) ?? 0);
    return Number.isFinite(until) && Date.now() < until;
  } catch { return false; }
}

function snooze(): void {
  try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 86_400_000)); }
  catch { /* private mode — it'll ask again, which is survivable */ }
}

/**
 * "Install ServdGo" — the banner that turns a browser tab into an
 * app on the home screen.
 *
 * Three different browsers, three different truths:
 *
 *  - Chrome on Android fires `beforeinstallprompt`, so there is a real button
 *    that opens the real install dialog.
 *  - Safari on iOS has no such event and never will. The only route is Share →
 *    Add to Home Screen, so all we can do is say so, clearly.
 *  - Messenger and Instagram's in-app browsers cannot install anything at all.
 *    Offering a button there would be a lie; the honest move is to send them to
 *    Chrome.
 *
 * Waits a few seconds before appearing — a banner that beats the page to the
 * screen reads as an ad for something the customer hasn't seen yet.
 */
export function InstallApp() {
  const [evt, setEvt] = useState<InstallPromptEvent | null>(null);
  const [ready, setReady] = useState(false);
  const [gone, setGone] = useState(() => snoozed() || isInstalledApp());
  const [iosHelp, setIosHelp] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Without preventDefault Chrome shows its own mini-infobar and we lose
      // the event, which is how "install" ends up buried in a browser menu.
      e.preventDefault();
      setEvt(e as InstallPromptEvent);
    };
    const onInstalled = () => setGone(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    const t = setTimeout(() => setReady(true), 3500);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      clearTimeout(t);
    };
  }, []);

  if (gone || !ready) return null;

  const inApp = isInAppBrowser();
  const ios = isIOS();
  // Nothing to offer: a desktop browser, or one that never fired the event.
  if (!evt && !ios && !inApp) return null;

  function dismiss() { snooze(); setGone(true); }

  async function install() {
    if (!evt) return;
    await evt.prompt();
    const { outcome } = await evt.userChoice;
    // Declined is an answer. Asking again tomorrow is how a banner becomes an
    // advert people learn to swipe away without reading.
    if (outcome === 'dismissed') dismiss();
    setEvt(null);
  }

  return (
    <div className="fixed inset-x-0 bottom-[4.25rem] z-40 px-3 pb-1">
      <div className="mx-auto max-w-xl rounded-2xl bg-white p-3 shadow-lg ring-1 ring-black/10">
        <div className="flex items-start gap-3">
          <img src="/icons/pwa-192x192.png" alt="" className="h-11 w-11 shrink-0 rounded-xl ring-1 ring-black/10" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-brand-ink">Install ServdGo</p>
            <p className="mt-0.5 text-xs text-black/55">
              {inApp
                ? `Opening in ${inAppBrowserName()} — install from Chrome instead.`
                : 'Add it to your home screen: opens full screen, remembers your address, no browser bar.'}
            </p>
          </div>
          <button onClick={dismiss} aria-label="Not now"
            className="-mr-1 -mt-1 shrink-0 rounded-lg px-2 py-1 text-lg leading-none text-black/35">×</button>
        </div>

        {inApp ? (
          <div className="mt-2.5 flex gap-2">
            {isAndroid() && (
              <button onClick={openInChrome}
                className="flex-1 rounded-xl bg-brand-green py-2.5 text-sm font-bold text-white">
                Open in Chrome
              </button>
            )}
            {!isAndroid() && (
              <p className="text-xs text-black/55">
                Tap the ••• menu at the top right, then <b>Open in browser</b>, and install from there.
              </p>
            )}
          </div>
        ) : evt ? (
          <button onClick={() => void install()}
            className="mt-2.5 w-full rounded-xl bg-brand-green py-2.5 text-sm font-bold text-white">
            Install app
          </button>
        ) : (
          <>
            <button onClick={() => setIosHelp((v) => !v)}
              className="mt-2.5 w-full rounded-xl bg-brand-green py-2.5 text-sm font-bold text-white">
              {iosHelp ? 'Hide the steps' : 'Show me how'}
            </button>
            {iosHelp && (
              <ol className="mt-2 space-y-1 rounded-xl bg-brand-green/[0.06] p-3 text-xs text-black/70">
                <li>1. Tap the <b>Share</b> button at the bottom of Safari — the square with an arrow going up.</li>
                <li>2. Scroll down and tap <b>Add to Home Screen</b>.</li>
                <li>3. Tap <b>Add</b>. The ServdGo icon appears with your other apps.</li>
              </ol>
            )}
          </>
        )}
      </div>
    </div>
  );
}
