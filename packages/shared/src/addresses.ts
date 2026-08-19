/**
 * Saved delivery addresses.
 *
 * A customer sets one when they make the account and picks it at checkout, so
 * the pin is placed for them. Pinning a map on a phone is fiddly, and doing it
 * again for every order is a chance to get it wrong — the fewest wrong pins is
 * the point of all of this.
 *
 * These are the pure rules: what counts as "the same place", and what to call a
 * new one.
 */

import { haversineMeters, type LatLng } from './tracking.ts';

/** The shape both apps and the database agree on. */
export interface SavedAddress {
  id: string;
  label: string | null;
  address: string;
  lat: number | null;
  lng: number | null;
  is_default: boolean;
}

/**
 * How close two pins must be to count as the same doorstep.
 *
 * Generous on purpose: a customer re-pinning their own house lands a few metres
 * off every time, and prompting them to "save" an address they already have is
 * worse than missing one.
 */
export const SAME_PLACE_METERS = 120;

/** Normalize written addresses enough to compare them by eye, not by byte. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Whether a drop-off matches an address the customer already has saved. */
export function matchesSavedAddress(
  saved: SavedAddress,
  drop: { pin?: LatLng | null; address?: string | null },
): boolean {
  if (drop.pin && saved.lat != null && saved.lng != null) {
    if (haversineMeters({ lat: saved.lat, lng: saved.lng }, drop.pin) <= SAME_PLACE_METERS) return true;
  }
  const a = normalize(saved.address);
  const b = normalize(drop.address ?? '');
  return a.length > 0 && a === b;
}

/** The saved address this drop-off came from, or null when it's somewhere new. */
export function findSavedAddress(
  saved: readonly SavedAddress[],
  drop: { pin?: LatLng | null; address?: string | null },
): SavedAddress | null {
  return saved.find((s) => matchesSavedAddress(s, drop)) ?? null;
}

/** True when this drop-off is worth offering to save. */
export function isNewAddress(
  saved: readonly SavedAddress[],
  drop: { pin?: LatLng | null; address?: string | null },
): boolean {
  const hasSomething = Boolean(drop.pin) || Boolean(drop.address?.trim());
  return hasSomething && findSavedAddress(saved, drop) === null;
}

/** The labels offered as one-tap choices when saving. */
export const ADDRESS_LABELS = ['Home', 'Office'] as const;

/**
 * A name for an unlabelled address: the first free "Address N".
 *
 * @example
 * nextAddressLabel([{ label: 'Home' }]) // 'Address 2'
 */
export function nextAddressLabel(saved: readonly { label: string | null }[]): string {
  for (let n = saved.length + 1; ; n++) {
    const candidate = `Address ${n}`;
    if (!saved.some((s) => s.label?.trim().toLowerCase() === candidate.toLowerCase())) return candidate;
  }
}

/** Which one-tap labels are still free (a second "Home" helps nobody). */
export function availableLabels(saved: readonly { label: string | null }[]): string[] {
  const taken = new Set(saved.map((s) => s.label?.trim().toLowerCase()).filter(Boolean));
  return ADDRESS_LABELS.filter((l) => !taken.has(l.toLowerCase()));
}

/** What to show for an address in a list: its label, else its first line. */
export function addressTitle(a: SavedAddress): string {
  const label = a.label?.trim();
  if (label) return label;
  const firstLine = a.address.split(',')[0]?.trim();
  return firstLine || 'Saved address';
}

/** Default first, then alphabetically — the order a chooser should show them. */
export function sortAddresses<T extends SavedAddress>(saved: readonly T[]): T[] {
  return [...saved].sort(
    (a, b) => Number(b.is_default) - Number(a.is_default) || addressTitle(a).localeCompare(addressTitle(b)),
  );
}
