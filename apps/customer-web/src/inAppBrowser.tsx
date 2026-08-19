/**
 * Messenger, Facebook and Instagram open links in their own embedded webview,
 * and that webview does not hand out the device location — "Use my location"
 * either does nothing or fails instantly, with no permission prompt to fix.
 *
 * The only real fix is to leave the webview, so detect it and offer the door.
 */

/** True when the page is running inside a social app's embedded browser. */
export function isInAppBrowser(ua = navigator.userAgent): boolean {
  return /FBAN|FBAV|FB_IAB|FBIOS|Messenger|Instagram|Line\/|Twitter|TikTok|MicroMessenger/i.test(ua);
}

/** Which app, for a message that names what the customer is actually looking at. */
export function inAppBrowserName(ua = navigator.userAgent): string {
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/FBAN|FBAV|FB_IAB|FBIOS|Messenger/i.test(ua)) return 'Messenger';
  if (/TikTok/i.test(ua)) return 'TikTok';
  if (/Line\//i.test(ua)) return 'LINE';
  return 'this app';
}

export function isAndroid(ua = navigator.userAgent): boolean {
  return /Android/i.test(ua);
}

/**
 * Android can be handed straight to Chrome with an intent: URL. iOS has no
 * equivalent that works from inside a webview, so there the customer has to use
 * the app's own "Open in browser" menu — we tell them where it is instead.
 */
export function openInChrome(): void {
  const url = window.location.href;
  if (isAndroid()) {
    const withoutScheme = url.replace(/^https?:\/\//, '');
    window.location.href =
      `intent://${withoutScheme}#Intent;scheme=https;package=com.android.chrome;end`;
    return;
  }
  // iOS: Chrome registers googlechrome://. Harmless no-op if Chrome isn't installed.
  window.location.href = url.replace(/^https:\/\//, 'googlechrome://').replace(/^http:\/\//, 'googlechrome://');
}

export async function copyCurrentLink(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(window.location.href);
    return true;
  } catch {
    return false;
  }
}
