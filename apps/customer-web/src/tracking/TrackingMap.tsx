import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LatLng } from '@servdgo/shared';
import type { OrderRiderInfo } from '@servdgo/supabase';
import { useTracking } from './useTracking.ts';

const pinIcon = (bg: string, emoji: string) =>
  L.divIcon({
    className: '',
    html: `<div style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:${bg};box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,.4);font-size:16px;">${emoji}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });

const ICONS = {
  pickup: pinIcon('#23262b', '🏪'),
  dropoff: pinIcon('#1e1e1e', '📍'),
  rider: pinIcon('#e8552f', '🛵'),
};

const STATUS_LABEL: Record<string, string> = {
  accepted: 'Rider assigned', preparing: 'Preparing your order',
  picked_up: 'Picked up — on the way', on_the_way: 'On the way to you',
};

type LL = [number, number];

/**
 * Live tracking on a real OpenStreetMap map (Leaflet). The route follows actual
 * roads (OSRM, with a straight-line fallback); the rider marker follows realtime
 * location pings. A courier card shows the assigned rider with a call button.
 */
export function TrackingMap({
  pickup, dropoff, orderId, deliveryStatus, courier, onClose,
}: {
  pickup: LatLng; dropoff: LatLng; orderId?: string;
  deliveryStatus?: string; courier?: OrderRiderInfo | null; onClose?: () => void;
}) {
  const { rider, etaMin, progress, live } = useTracking(pickup, dropoff, orderId);

  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const riderRef = useRef<L.Marker | null>(null);
  const routeRef = useRef<L.Polyline | null>(null);
  const [routePts, setRoutePts] = useState<LL[] | null>(null);

  // Fetch a road-following route once (falls back to a straight line).
  useEffect(() => {
    let cancelled = false;
    const url = `https://router.project-osrm.org/route/v1/driving/${pickup.lng},${pickup.lat};${dropoff.lng},${dropoff.lat}?overview=full&geometries=geojson`;
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        const coords = d?.routes?.[0]?.geometry?.coordinates as [number, number][] | undefined;
        if (!cancelled && coords?.length) setRoutePts(coords.map(([lng, lat]) => [lat, lng] as LL));
      })
      .catch(() => { /* keep straight-line fallback */ });
    return () => { cancelled = true; };
  }, [pickup.lat, pickup.lng, dropoff.lat, dropoff.lng]);

  // Initialise the map once.
  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true });
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap',
    }).addTo(map);

    L.marker([pickup.lat, pickup.lng], { icon: ICONS.pickup, title: 'Pickup' }).addTo(map);
    L.marker([dropoff.lat, dropoff.lng], { icon: ICONS.dropoff, title: 'Drop-off' }).addTo(map);
    routeRef.current = L.polyline(
      [[pickup.lat, pickup.lng], [dropoff.lat, dropoff.lng]],
      { color: '#e8552f', weight: 4, opacity: 0.85 },
    ).addTo(map);
    riderRef.current = L.marker([rider.lat, rider.lng], { icon: ICONS.rider, title: 'Rider', zIndexOffset: 1000 }).addTo(map);

    map.fitBounds(L.latLngBounds([[pickup.lat, pickup.lng], [dropoff.lat, dropoff.lng]]).pad(0.25));
    setTimeout(() => map.invalidateSize(), 0);

    return () => { map.remove(); mapRef.current = null; riderRef.current = null; routeRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Draw the road route once available; else keep the straight fallback.
  useEffect(() => {
    if (routeRef.current) routeRef.current.setLatLngs(routePts ?? [[pickup.lat, pickup.lng], [dropoff.lat, dropoff.lng]]);
  }, [routePts, pickup.lat, pickup.lng, dropoff.lat, dropoff.lng]);

  // Move the rider marker as new pings arrive.
  useEffect(() => {
    riderRef.current?.setLatLng([rider.lat, rider.lng]);
  }, [rider.lat, rider.lng]);

  const arrived = progress >= 1;
  const statusText = deliveryStatus ? (STATUS_LABEL[deliveryStatus] ?? deliveryStatus.replaceAll('_', ' ')) : null;

  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-bold">Tracking your rider</h2>
        {onClose && <button onClick={onClose} className="text-sm text-brand-charcoal">Close</button>}
      </div>

      <div ref={elRef} className="h-72 w-full overflow-hidden rounded-lg" style={{ background: '#f5f1ee' }} />

      <div className="mt-3 flex items-center justify-between">
        <span className="text-sm text-black/60">
          {statusText ?? (live ? 'Live' : 'Simulated')} · {Math.round(progress * 100)}% of the way
        </span>
        <span className="rounded-lg bg-brand-orange/15 px-3 py-1 text-sm font-semibold text-green-800">
          {arrived ? 'Arriving now' : `ETA ~${Math.max(1, Math.round(etaMin))} min`}
        </span>
      </div>

      {courier?.name && (
        <div className="mt-3 flex items-center justify-between rounded-xl bg-black/[0.03] px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-orange/15 text-lg">
              {courier.photo_url ? <img src={courier.photo_url} alt="" className="h-full w-full object-cover" /> : '🛵'}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{courier.name}</p>
              <p className="text-xs text-black/45">Your rider</p>
            </div>
          </div>
          {courier.mobile_number && (
            <a href={`tel:${courier.mobile_number}`} aria-label="Call rider"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-orange text-white">📞</a>
          )}
        </div>
      )}
    </div>
  );
}
