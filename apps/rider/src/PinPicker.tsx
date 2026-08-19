import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { locateOnce } from './geo.ts';

type Pt = { lat: number; lng: number };

/** Green teardrop, matching the drop-off pin on the delivery map. */
const dropIcon = L.divIcon({
  className: 'ebd-pin',
  html:
    '<svg width="28" height="40" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 27 15 27s15-16.5 15-27C30 6.7 23.3 0 15 0z" fill="#6DBE22"/>'
    + '<circle cx="15" cy="15" r="6" fill="#fff"/></svg>',
  iconSize: [28, 40], iconAnchor: [14, 40],
});

/**
 * Drag-and-drop pin picker for the rider.
 *
 * The rider is usually standing in the right place, so "I'm here" does the job
 * in one tap. But sometimes the customer is describing it over the phone — "the
 * blue gate past the basketball court" — and then the rider needs to move the
 * pin somewhere they aren't. Both, on one small map.
 */
export function PinPicker({ value, onChange, height = 220 }: {
  value: Pt | null;
  onChange: (p: Pt) => void;
  height?: number;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const start: L.LatLngTuple = value ? [value.lat, value.lng] : [14.9765, 120.5265];
    const map = L.map(elRef.current, { attributionControl: false }).setView(start, value ? 17 : 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

    const marker = L.marker(start, { icon: dropIcon, draggable: true }).addTo(map);
    marker.on('dragend', () => {
      const p = marker.getLatLng();
      onChangeRef.current({ lat: p.lat, lng: p.lng });
    });
    map.on('click', (e: L.LeafletMouseEvent) => {
      marker.setLatLng(e.latlng);
      onChangeRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
    });

    markerRef.current = marker;
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; markerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function useMyLocation() {
    setLocating(true); setNote(null);
    try {
      const { lat, lng, warning } = await locateOnce();
      markerRef.current?.setLatLng([lat, lng]);
      mapRef.current?.setView([lat, lng], 17);
      onChangeRef.current({ lat, lng });
      setNote(warning);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setLocating(false);
    }
  }

  return (
    <div>
      <div ref={elRef} style={{ height }} className="w-full overflow-hidden rounded-xl ring-1 ring-black/10" />
      <button type="button" onClick={() => void useMyLocation()} disabled={locating}
        className="mt-2 w-full rounded-lg border border-brand-green/50 py-2 text-xs font-semibold text-green-700 disabled:opacity-50">
        {locating ? 'Reading your location…' : '📍 I\'m standing there — use my location'}
      </button>
      {note && <p className="mt-1 rounded-lg bg-brand-yellow/25 px-2.5 py-1.5 text-[11px] text-yellow-900">{note}</p>}
      <p className="mt-1 text-[11px] text-black/40">Or tap the map, or drag the pin.</p>
    </div>
  );
}
