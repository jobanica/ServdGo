/**
 * App install tracking + the admin adoption/engagement snapshot.
 *
 * The customer app is an installable PWA and the rider app ships as a native
 * Android build; both register their device once so the operator can see how
 * many people actually installed the app, alongside who is actively using it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type AppName = 'customer' | 'rider';

const DEVICE_KEY = 'ebd:device-id';
const INSTALLED_KEY = 'ebd:install-recorded';

/** A stable per-device id so re-opening the app doesn't inflate the count. */
function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = (globalThis.crypto?.randomUUID?.() ?? `d${Date.now()}${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return `anon-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Record that this device has the app installed. Safe to call on every launch —
 * it is deduplicated per device both locally and by a unique constraint.
 */
export async function recordAppInstall(
  db: SupabaseClient, app: AppName, platform = 'pwa',
): Promise<void> {
  try {
    if (localStorage.getItem(INSTALLED_KEY) === app) return;
  } catch { /* storage blocked — still try once */ }

  const { data: { user } } = await db.auth.getUser().catch(() => ({ data: { user: null } }));
  const { error } = await db.from('app_installs').insert({
    app, platform, device_id: deviceId(), profile_id: user?.id ?? null,
  });
  // A duplicate just means this device is already counted.
  if (!error || error.code === '23505') {
    try { localStorage.setItem(INSTALLED_KEY, app); } catch { /* ignore */ }
  }
}

/** True when the app is running as an installed app rather than a browser tab. */
export function isInstalledApp(): boolean {
  // This package is built without the DOM lib (it also runs under node in
  // tests), so reach for the browser globals through `globalThis`.
  const w = globalThis as unknown as {
    matchMedia?: (q: string) => { matches: boolean };
    navigator?: { standalone?: boolean };
  };
  try {
    return w.matchMedia?.('(display-mode: standalone)').matches === true
      || w.navigator?.standalone === true;
  } catch { return false; }
}

export interface UserActivity {
  window_days: number;
  customers_total: number;
  customers_active: number;
  customers_new: number;
  riders_total: number;
  riders_active: number;
  riders_online: number;
  riders_suspended: number;
  riders_pending: number;
  installs_total: number;
  installs_customer: number;
  installs_rider: number;
  installs_new: number;
  orders_in_window: number;
}

/** Adoption + engagement snapshot over the last `days` (staff only). */
export async function getUserActivity(db: SupabaseClient, days = 30): Promise<UserActivity> {
  const { data, error } = await db.rpc('admin_user_activity', { p_days: days });
  if (error) throw error;
  return data as UserActivity;
}
