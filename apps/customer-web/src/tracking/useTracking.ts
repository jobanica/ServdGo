import { useEffect, useRef, useState } from 'react';
import { haversineMeters, etaMinutes, lerpLatLng, type LatLng } from '@ebd/shared';
import { subscribeRiderLocation } from '@ebd/supabase';
import { supabase } from '../lib/supabase.ts';

export interface TrackingState {
  rider: LatLng;
  etaMin: number;
  progress: number; // 0..1 along the route (for the marker on the line)
  live: boolean;
}

/**
 * Live rider tracking for an order. With Supabase + an orderId it subscribes to
 * the rider's realtime location; otherwise it simulates a rider moving from
 * pickup to dropoff so the map is demonstrable in preview.
 */
export function useTracking(
  pickup: LatLng,
  dropoff: LatLng,
  orderId?: string,
  simulateMs = 20_000,
): TrackingState {
  const [rider, setRider] = useState<LatLng>(pickup);
  const [progress, setProgress] = useState(0);
  const live = Boolean(supabase && orderId);
  const start = useRef<number>(Date.now());

  useEffect(() => {
    if (supabase && orderId) {
      // Live: move the marker from realtime pings; progress from distance ratio.
      const total = haversineMeters(pickup, dropoff) || 1;
      return subscribeRiderLocation(supabase, orderId, (ping) => {
        setRider({ lat: ping.lat, lng: ping.lng });
        const remaining = haversineMeters(ping, dropoff);
        setProgress(Math.min(1, Math.max(0, 1 - remaining / total)));
      });
    }
    // Preview: interpolate pickup -> dropoff.
    start.current = Date.now();
    const id = setInterval(() => {
      const t = Math.min(1, (Date.now() - start.current) / simulateMs);
      setProgress(t);
      setRider(lerpLatLng(pickup, dropoff, t));
      if (t >= 1) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [orderId, pickup.lat, pickup.lng, dropoff.lat, dropoff.lng, simulateMs]);

  return { rider, progress, live, etaMin: etaMinutes(haversineMeters(rider, dropoff)) };
}
