/**
 * Why "Use my location" didn't work, in words a customer can act on.
 *
 * A browser hands back a bare numeric code and nothing else, and every app that
 * ignores it produces the same complaint: "it's not activating". On iPhone in
 * particular the cause is almost never the page — it is Location Services
 * switched off for Safari, a permission dismissed weeks ago, or simply a slow
 * first fix indoors. Each needs a different sentence, and none of them is
 * "something went wrong".
 *
 * Kept free of DOM types so it can be tested; the browser bits live in each app.
 */

/** The three codes in the Geolocation spec. */
export const GEO_PERMISSION_DENIED = 1;
export const GEO_POSITION_UNAVAILABLE = 2;
export const GEO_TIMEOUT = 3;

export interface GeoContext {
  /** iPhone or iPad — the settings path differs from everywhere else. */
  ios: boolean;
  /** Launched from the Home Screen, which carries its own permission on iOS. */
  standalone: boolean;
  /** Messenger, Instagram and friends, which block location outright. */
  inAppBrowser: string | null;
}

/** Always offered, because it always works. */
const FALLBACK = 'Or just tap the map to drop your pin.';

/**
 * A sentence explaining a failed location request, and what to do about it.
 *
 * @example
 * geolocationHelp(1, { ios: true, standalone: false, inAppBrowser: null })
 * // "Safari isn't allowed to use your location. Open Settings › Privacy & …"
 */
export function geolocationHelp(code: number, ctx: GeoContext): string {
  if (ctx.inAppBrowser) {
    return `${ctx.inAppBrowser} blocks location for pages opened inside it. `
      + `Open this page in ${ctx.ios ? 'Safari' : 'Chrome'} and it will work. ${FALLBACK}`;
  }

  if (code === GEO_PERMISSION_DENIED) {
    if (ctx.ios && ctx.standalone) {
      return 'Location is switched off for this app. Open Settings › Privacy & Security › '
        + 'Location Services, turn it on, then find ServdGo in the list and choose '
        + `"While Using the App". ${FALLBACK}`;
    }
    if (ctx.ios) {
      return "Safari isn't allowed to use your location. Open Settings › Privacy & Security › "
        + 'Location Services › Safari Websites and choose "While Using the App", then come back '
        + `and tap it again. ${FALLBACK}`;
    }
    return 'Your browser blocked the location request. Allow location for this site in your '
      + `browser settings and try again. ${FALLBACK}`;
  }

  if (code === GEO_TIMEOUT) {
    return 'That took too long — phones can be slow to find a first fix indoors. '
      + `Try once more near a window, or step outside. ${FALLBACK}`;
  }

  // POSITION_UNAVAILABLE, and anything unrecognised.
  return "Your phone couldn't work out where it is right now. This usually clears up outdoors "
    + `or near a window. ${FALLBACK}`;
}

/**
 * Above this, a "location" is a neighbourhood rather than a doorstep — which is
 * what an iPhone reports when Precise Location is off for the browser.
 */
export const COARSE_ACCURACY_M = 1000;

/** True when a fix is too vague to deliver to. */
export function isCoarseFix(accuracyM: number | null | undefined): boolean {
  return accuracyM != null && Number.isFinite(accuracyM) && accuracyM > COARSE_ACCURACY_M;
}

/** What to tell someone whose phone only gave a rough position. */
export function coarseFixHelp(ctx: Pick<GeoContext, 'ios'>): string {
  return ctx.ios
    ? 'Your iPhone gave only a rough position — Precise Location is off. Turn it on in '
      + 'Settings › Privacy & Security › Location Services, or drag the pin to your exact spot.'
    : 'Your phone gave only a rough position. Please drag the pin to your exact spot.';
}
