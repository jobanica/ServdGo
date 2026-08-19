/**
 * Store opening hours. A store carries an optional daily open/close time
 * (`opensAt`/`closesAt` as "HH:MM" or "HH:MM:SS") plus an optional set of open
 * weekdays (`openDays`, 0=Sunday…6=Saturday). The effective "open now" state is
 * derived from the current wall-clock time and weekday in the Philippines, so a
 * store auto-opens and auto-closes on schedule without any background job.
 */

const MANILA_TZ = 'Asia/Manila';

/** Short weekday names, index 0 = Sunday … 6 = Saturday. */
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Parse "HH:MM[:SS]" to minutes since midnight, or null if absent/invalid. */
export function parseHm(t?: string | null): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Current time-of-day in Manila, as minutes since midnight. */
export function manilaMinutes(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MANILA_TZ, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const min = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + min;
}

/** Current weekday in Manila: 0 = Sunday … 6 = Saturday. */
export function manilaWeekday(now: Date = new Date()): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: MANILA_TZ, weekday: 'short' }).format(now);
  const i = WEEKDAYS.indexOf(wd as (typeof WEEKDAYS)[number]);
  return i < 0 ? now.getDay() : i;
}

/**
 * Whether a store is open right now given its schedule:
 *  - openDays: the weekdays it operates (0=Sun…6=Sat). Null/empty → every day.
 *  - opensAt/closesAt: the daily window. Either bound null → open all day.
 * Supports overnight windows (e.g. 18:00–02:00). A closed weekday wins.
 */
export function isOpenNow(
  opensAt?: string | null,
  closesAt?: string | null,
  openDays?: number[] | null,
  now: Date = new Date(),
): boolean {
  if (openDays && openDays.length > 0 && !openDays.includes(manilaWeekday(now))) return false;
  const o = parseHm(opensAt);
  const c = parseHm(closesAt);
  if (o == null || c == null) return true; // no time window → open all day (on open days)
  if (o === c) return true;                // equal bounds → treated as 24 hours
  const cur = manilaMinutes(now);
  return o < c ? cur >= o && cur < c       // same-day window
               : cur >= o || cur < c;      // window crosses midnight
}

/** Format "HH:MM[:SS]" as a friendly 12-hour label, e.g. "9:00 AM". */
export function formatHm(t?: string | null): string {
  const mins = parseHm(t);
  if (mins == null) return '';
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/**
 * A short label for which days a store is open, e.g. "Every day",
 * "Closed Sun", "Closed Sun, Wed", or "Mon, Tue, Fri" when it's open on few.
 */
export function daysLabel(openDays?: number[] | null): string {
  if (!openDays || openDays.length === 0 || openDays.length >= 7) return 'Every day';
  const open = [...new Set(openDays)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (open.length === 0) return 'Closed';
  const closed = ALL_DAYS.filter((d) => !open.includes(d));
  if (closed.length <= 3) return `Closed ${closed.map((d) => WEEKDAYS[d]).join(', ')}`;
  return open.map((d) => WEEKDAYS[d]).join(', ');
}

/** A combined human label for a store's schedule (days + hours). */
export function scheduleLabel(opensAt?: string | null, closesAt?: string | null, openDays?: number[] | null): string {
  const o = formatHm(opensAt);
  const c = formatHm(closesAt);
  const hours = o && c ? `${o} – ${c}` : 'Open 24 hours';
  const days = daysLabel(openDays);
  return days === 'Every day' ? hours : `${days} · ${hours}`;
}
