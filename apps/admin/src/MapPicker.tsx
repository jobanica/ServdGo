import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/** Fallback map center — a point in Metro Manila / Rizal (matches tracking test). */
const DEFAULT_CENTER: L.LatLngTuple = [14.6, 121.0];

/** Brand-purple teardrop pin as a divIcon (no external image assets to bundle). */
const pinIcon = L.divIcon({
  className: 'ebd-pin',
  html:
    '<svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 27 15 27s15-16.5 15-27C30 6.7 23.3 0 15 0z" fill="#5E2D91"/>' +
    '<circle cx="15" cy="15" r="6" fill="#fff"/></svg>',
  iconSize: [30, 42],
  iconAnchor: [15, 42],
});

export interface MapValue { lat: number; lng: number }

/**
 * Interactive location picker for a store. Click the map or drag the pin to set
 * the exact spot; the chosen lat/lng drives distance-based delivery-fee math.
 * Uses OpenStreetMap tiles (no API key) and Nominatim for optional address search.
 */
export function MapPicker({
  value, onChange, height = 260,
}: { value: MapValue | null; onChange: (v: MapValue) => void; height?: number }) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  // Initialise the map once.
  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const start: L.LatLngTuple = value ? [value.lat, value.lng] : DEFAULT_CENTER;
    const map = L.map(elRef.current).setView(start, value ? 16 : 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    const place = (lat: number, lng: number) => {
      if (markerRef.current) {
        markerRef.current.setLatLng([lat, lng]);
      } else {
        const m = L.marker([lat, lng], { icon: pinIcon, draggable: true }).addTo(map);
        m.on('dragend', () => {
          const p = m.getLatLng();
          onChangeRef.current({ lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) });
        });
        markerRef.current = m;
      }
      onChangeRef.current({ lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
    };

    if (value) place(value.lat, value.lng);
    map.on('click', (e: L.LeafletMouseEvent) => place(e.latlng.lat, e.latlng.lng));
    mapRef.current = map;

    // Leaflet needs a size recalculation once the container has laid out.
    setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; markerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect an externally-changed value (e.g. switching which store is edited).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !value) return;
    if (markerRef.current) markerRef.current.setLatLng([value.lat, value.lng]);
    else markerRef.current = L.marker([value.lat, value.lng], { icon: pinIcon, draggable: true })
      .addTo(map)
      .on('dragend', function (this: L.Marker) {
        const p = this.getLatLng();
        onChangeRef.current({ lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) });
      });
    map.setView([value.lat, value.lng], Math.max(map.getZoom(), 16));
  }, [value?.lat, value?.lng]);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true); setSearchErr(null);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      const hits = (await res.json()) as { lat: string; lon: string }[];
      if (!hits.length) { setSearchErr('No match — try a nearby landmark or drop the pin manually.'); return; }
      const lat = +hits[0]!.lat, lng = +hits[0]!.lon;
      mapRef.current?.setView([lat, lng], 16);
      if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
      else if (mapRef.current) {
        markerRef.current = L.marker([lat, lng], { icon: pinIcon, draggable: true })
          .addTo(mapRef.current)
          .on('dragend', function (this: L.Marker) {
            const p = this.getLatLng();
            onChangeRef.current({ lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) });
          });
      }
      onChangeRef.current({ lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
    } catch {
      setSearchErr('Search failed — check your connection or drop the pin manually.');
    } finally { setSearching(false); }
  }

  function useMyLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      mapRef.current?.setView([lat, lng], 16);
      if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
      onChangeRef.current({ lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
    });
  }

  return (
    <div>
      <form onSubmit={search} className="mb-2 flex gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search address or landmark"
          className="flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-brand-green" />
        <button type="submit" disabled={searching}
          className="rounded-lg bg-brand-purple px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
          {searching ? '…' : 'Find'}
        </button>
        <button type="button" onClick={useMyLocation}
          className="rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-black/10 hover:bg-black/[0.03]">
          📍 Me
        </button>
      </form>
      {searchErr && <p className="mb-2 text-xs text-red-600">{searchErr}</p>}
      <div ref={elRef} style={{ height }} className="w-full overflow-hidden rounded-lg ring-1 ring-black/10" />
      <p className="mt-1.5 text-xs text-black/50">
        {value
          ? <>Pinned at <span className="font-mono">{value.lat.toFixed(5)}, {value.lng.toFixed(5)}</span> — click or drag to adjust.</>
          : <>Click the map (or search) to pin the store’s exact location.</>}
      </p>
    </div>
  );
}
