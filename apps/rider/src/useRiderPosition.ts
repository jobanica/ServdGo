import { useEffect, useState } from 'react';
import type { LatLng } from '@servdgo/shared';

/**
 * The rider's own position, watched once for the whole app.
 *
 * Used to tell them how far a request's store is before they take it — a job
 * across town is a different proposition from one on the next street, and the
 * pool card should say so. Stays null when permission is refused or the device
 * has no GPS; every caller treats that as "no distance to show".
 */
export function useRiderPosition(): LatLng | null {
  const [pos, setPos] = useState<LatLng | null>(null);

  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    const id = navigator.geolocation.watchPosition(
      (p) => setPos({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => { /* permission refused / unavailable — no distances, no error */ },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  return pos;
}

/** Human-readable distance: metres under a km, one decimal above it. */
export function formatDistance(meters: number): string {
  return meters < 950 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
}
