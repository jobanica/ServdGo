import { useEffect } from 'react';
import type { OrderStatus } from '@servdgo/shared';
import { startPublishingLocation, openLocationChannel } from '@servdgo/supabase';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { supabase } from './lib/supabase.ts';

// ---------------------------------------------------------------------------
// @capacitor-community/background-geolocation — minimal typed surface.
// On Android it runs a foreground service (persistent notification), so
// location keeps streaming while the app is backgrounded OR fully closed.
// ---------------------------------------------------------------------------
interface BgLocation {
  latitude: number;
  longitude: number;
}
interface AddWatcherOptions {
  backgroundMessage?: string;
  backgroundTitle?: string;
  requestPermissions?: boolean;
  stale?: boolean;
  distanceFilter?: number;
}
interface BackgroundGeolocationPlugin {
  addWatcher(
    options: AddWatcherOptions,
    callback: (location?: BgLocation, error?: { code: string }) => void,
  ): Promise<string>;
  removeWatcher(options: { id: string }): Promise<void>;
}
const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

/** Browser poll fallback (foreground only) via navigator.geolocation. */
function webPoll(orderId: string): () => void {
  return startPublishingLocation(supabase!, orderId, () =>
    new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) return reject(new Error('no geolocation'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        reject,
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 8000 },
      );
    }),
  );
}

/**
 * Native background watcher: a foreground service streams locations even when
 * the app is closed. Each fix is broadcast on the order's Realtime channel.
 */
function nativeWatch(orderId: string): () => void {
  const chan = openLocationChannel(supabase!, orderId);
  let watcherId: string | null = null;

  void BackgroundGeolocation.addWatcher(
    {
      backgroundTitle: 'ServdGo Rider — delivering',
      backgroundMessage: 'Sharing your location so the customer can track the delivery.',
      requestPermissions: true,
      stale: false,
      distanceFilter: 15, // metres between updates
    },
    (location, error) => {
      if (error || !location) return;
      void chan.publish({ lat: location.latitude, lng: location.longitude });
    },
  ).then((id) => { watcherId = id; });

  return () => {
    if (watcherId) void BackgroundGeolocation.removeWatcher({ id: watcherId });
    chan.close();
  };
}

/**
 * Share the rider's GPS on the order's channel while the delivery is in transit
 * (picked_up / on_the_way). Auto-starts on pickup, stops on delivery/unmount —
 * never shared while idle. Native builds use a foreground-service watcher
 * (works app-closed); the web build polls in the foreground.
 */
export function useLocationPublisher(orderId: string, status: OrderStatus) {
  const inTransit = status === 'picked_up' || status === 'on_the_way';
  useEffect(() => {
    if (!supabase || !inTransit) return;
    return Capacitor.isNativePlatform() ? nativeWatch(orderId) : webPoll(orderId);
  }, [orderId, inTransit]);
}
