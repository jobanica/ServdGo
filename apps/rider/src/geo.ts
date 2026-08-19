import { geolocationHelp, coarseFixHelp, isCoarseFix } from '@ebd/shared';

/** iPhone/iPad, including iPadOS which reports itself as a Mac with a touchscreen. */
function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
}

function context() {
  return {
    ios: isIOS(),
    standalone: window.matchMedia?.('(display-mode: standalone)').matches === true
      || (navigator as { standalone?: boolean }).standalone === true,
    inAppBrowser: null,
  };
}

export interface Fix { lat: number; lng: number; accuracy: number; warning: string | null }

/**
 * The rider's own position, once, with a deadline.
 *
 * `getCurrentPosition` has no default timeout, so a phone that can't get a fix
 * leaves the button stuck on "Reading your location…" indefinitely. Every pin a
 * rider sets this way is a doorstep or a shopfront, so accuracy is worth the
 * extra second or two.
 */
export function locateOnce(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This phone has no location support.'));
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
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  });
}
