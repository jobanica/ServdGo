import { geolocationHelp, coarseFixHelp, isCoarseFix, type GeoContext } from '@servdgo/shared';
import { isInAppBrowser, inAppBrowserName } from './inAppBrowser.tsx';

/** iPhone/iPad, including iPadOS which reports itself as a Mac with a touchscreen. */
export function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
}

/** Launched from the Home Screen, which on iOS carries its own location permission. */
export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || (navigator as { standalone?: boolean }).standalone === true;
}

function context(): GeoContext {
  return { ios: isIOS(), standalone: isStandalone(), inAppBrowser: isInAppBrowser() ? inAppBrowserName() : null };
}

export interface Fix {
  lat: number;
  lng: number;
  /** Radius of uncertainty in metres, as the device reports it. */
  accuracy: number;
  /** Set when the fix is too vague to deliver to — Precise Location off, usually. */
  warning: string | null;
}

/**
 * Ask the device where it is, once, and never hang.
 *
 * The default `getCurrentPosition` has no timeout at all, so an iPhone that
 * cannot get a fix leaves the button spinning "Locating…" for ever — which is
 * exactly what "it's not activating" looks like from the other side. Fifteen
 * seconds is generous for a cold GPS start and finite, which is the point.
 *
 * Rejects with a sentence the customer can act on, never a code.
 */
export function locateOnce(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser has no location support. Tap the map to drop your pin.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const accuracy = pos.coords.accuracy ?? 0;
        resolve({
          lat: +pos.coords.latitude.toFixed(6),
          lng: +pos.coords.longitude.toFixed(6),
          accuracy,
          warning: isCoarseFix(accuracy) ? coarseFixHelp(context()) : null,
        });
      },
      (err) => reject(new Error(geolocationHelp(err.code, context()))),
      // High accuracy matters: this pin is a doorstep, not a district.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  });
}

/**
 * Whether location has already been granted, when the browser will tell us.
 *
 * Used to decide whether a map may quietly centre itself on load. iOS shows its
 * permission sheet once and remembers a dismissal, so spending that one prompt
 * on a map the customer hasn't asked to move is how "Use my location" ends up
 * dead by the time they actually press it. Safari has supported the Permissions
 * API since 16; anywhere it is missing we assume not-yet-granted and wait for a
 * deliberate tap.
 */
export async function locationAlreadyGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    return status?.state === 'granted';
  } catch {
    return false;
  }
}
