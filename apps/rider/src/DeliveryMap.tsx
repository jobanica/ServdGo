import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

type Pt = { lat: number; lng: number };

/** Brand teardrop pin in a given fill (divIcon — no external image assets). */
function teardrop(fill: string) {
  return L.divIcon({
    className: 'ebd-pin',
    html:
      `<svg width="28" height="40" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">` +
      `<path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 27 15 27s15-16.5 15-27C30 6.7 23.3 0 15 0z" fill="${fill}"/>` +
      `<circle cx="15" cy="15" r="6" fill="#fff"/></svg>`,
    iconSize: [28, 40], iconAnchor: [14, 40], popupAnchor: [0, -36],
  });
}
const storeIcon = teardrop('#5E2D91');   // pickup / restaurant
const dropIcon = teardrop('#6DBE22');    // customer drop-off
const riderIcon = L.divIcon({
  className: 'ebd-rider',
  html: '<div style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9999px;background:#6DBE22;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);font-size:16px">🛵</div>',
  iconSize: [30, 30], iconAnchor: [15, 15],
});

/**
 * Live delivery map for the rider: pickup store(s), the customer drop-off, and
 * the rider's own position (watched via GPS). OSM tiles, no API key.
 */
export function DeliveryMap({ dropoff, stores, height = 200 }: {
  dropoff: Pt | null;
  stores: { name: string | null; lat: number | null; lng: number | null }[];
  height?: number;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const riderRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const storePts = stores.filter((s) => s.lat != null && s.lng != null) as { name: string | null; lat: number; lng: number }[];
    const pts: L.LatLngTuple[] = storePts.map((s) => [s.lat, s.lng]);
    if (dropoff) pts.push([dropoff.lat, dropoff.lng]);

    const map = L.map(elRef.current, { attributionControl: false }).setView(pts[0] ?? [14.6, 121.0], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

    storePts.forEach((s) => L.marker([s.lat, s.lng], { icon: storeIcon }).addTo(map).bindPopup(s.name ?? 'Pickup'));
    if (dropoff) L.marker([dropoff.lat, dropoff.lng], { icon: dropIcon }).addTo(map).bindPopup('Customer drop-off');
    // Dashed route between the (first) store and the drop-off.
    if (storePts[0] && dropoff) {
      L.polyline([[storePts[0].lat, storePts[0].lng], [dropoff.lat, dropoff.lng]],
        { color: '#5E2D91', weight: 3, dashArray: '6 6' }).addTo(map);
    }
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.3));
    else if (pts.length === 1) map.setView(pts[0]!, 15);
    setTimeout(() => map.invalidateSize(), 0);

    let watchId: number | undefined;
    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const p: L.LatLngTuple = [pos.coords.latitude, pos.coords.longitude];
          if (riderRef.current) riderRef.current.setLatLng(p);
          else riderRef.current = L.marker(p, { icon: riderIcon, zIndexOffset: 1000 }).addTo(map).bindPopup('You');
        },
        () => { /* ignore */ },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
      );
    }

    mapRef.current = map;
    return () => {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      map.remove(); mapRef.current = null; riderRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={elRef} style={{ height }} className="w-full overflow-hidden rounded-xl ring-1 ring-black/10" />;
}
