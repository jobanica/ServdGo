/**
 * Geo helpers for live rider tracking.
 *
 * The transport (how a rider's lat/lng reaches the customer) is Supabase
 * Realtime — see @ebd/supabase/tracking. These are the pure calculations the
 * map and ETA need. Map tile provider is open decision #9.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance between two points, in metres (haversine). */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Estimated minutes to cover a distance at an average speed (default 20 km/h). */
export function etaMinutes(distanceMeters: number, speedKmh = 20): number {
  if (speedKmh <= 0) return Infinity;
  const hours = distanceMeters / 1000 / speedKmh;
  return Math.max(0, hours * 60);
}

/** Linear interpolation between two points (t in [0,1]) — used by the simulator. */
export function lerpLatLng(a: LatLng, b: LatLng, t: number): LatLng {
  const c = Math.min(1, Math.max(0, t));
  return { lat: a.lat + (b.lat - a.lat) * c, lng: a.lng + (b.lng - a.lng) * c };
}

/** Recommended tracking update interval (ms). 3–5s balances smoothness vs battery. */
export const TRACKING_INTERVAL_MS = 4000;
