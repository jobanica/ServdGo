import { useEffect, useRef, useState } from 'react';
import { isInAppBrowser, inAppBrowserName, isAndroid, openInChrome, copyCurrentLink } from './inAppBrowser.tsx';
import { locateOnce, locationAlreadyGranted } from './geo.ts';
import { getAppSettings } from '@ebd/supabase';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * Where the map opens when there is no pin yet.
 *
 * It used to be Metro Manila, which for an operator working out of Pampanga
 * meant every fresh picker opened about fifty kilometres from anywhere it
 * serves. The operator's own service centre is the honest default; Manila only
 * survives as the fallback for a setup with no centre configured.
 */
let DEFAULT_CENTER: L.LatLngTuple = [14.6, 121.0];

/** Fetched once per session and reused by every picker on the page. */
let centreLoaded: Promise<void> | null = null;
function loadServiceCentre(): Promise<void> {
  if (!centreLoaded) {
    centreLoaded = (async () => {
      if (!supabase || !isSupabaseConfigured) return;
      try {
        const s = await getAppSettings(supabase);
        if (s.service_center_lat != null && s.service_center_lng != null) {
          DEFAULT_CENTER = [s.service_center_lat, s.service_center_lng];
        }
      } catch { /* the Manila fallback still gives a usable map */ }
    })();
  }
  return centreLoaded;
}

/** Same spot, to within a metre or so — used to stop a sync loop. */
const samePoint = (a: L.LatLng | null, b: LatLngValue) =>
  a != null && Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;

/** Teardrop pin (divIcon — no external image assets to bundle). */
const teardrop = (fill: string, cls: string) => L.divIcon({
  className: cls,
  html:
    '<svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">' +
    `<path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 27 15 27s15-16.5 15-27C30 6.7 23.3 0 15 0z" fill="${fill}"/>` +
    '<circle cx="15" cy="15" r="6" fill="#fff"/></svg>',
  iconSize: [30, 42],
  iconAnchor: [15, 42],
});

/** Where the rider buys — purple, matching the store pins on the tracking map. */
const storePin = teardrop('#5E2D91', 'ebd-store-pin');
/** Where it lands — brand green. */
const dropPin = teardrop('#6DBE22', 'ebd-drop-pin');

export interface LatLngValue { lat: number; lng: number }

/**
 * Shown only inside Messenger/Instagram/etc., where geolocation is blocked by
 * the embedded browser and no amount of retrying will help.
 */
export function InAppBrowserNotice() {
  const [copied, setCopied] = useState(false);
  if (!isInAppBrowser()) return null;
  const app = inAppBrowserName();
  return (
    <div className="mb-2 rounded-lg bg-brand-yellow/25 p-3 ring-1 ring-brand-yellow/60">
      <p className="text-sm font-bold text-yellow-900">⚠️ Open in Chrome to use your location</p>
      <p className="mt-0.5 text-xs text-yellow-900/80">
        You&apos;re browsing inside {app}, which blocks &ldquo;Use my location&rdquo;. Open Easy Buy
        Delivery in Chrome and it will work — or just tap the map to drop your pin manually.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={openInChrome}
          className="rounded-lg bg-brand-green px-3 py-1.5 text-xs font-bold text-white">
          Open in Chrome
        </button>
        <button type="button"
          onClick={() => { void copyCurrentLink().then((ok) => setCopied(ok)); }}
          className="rounded-lg border border-yellow-900/25 px-3 py-1.5 text-xs font-medium text-yellow-900">
          {copied ? 'Link copied ✓' : 'Copy link'}
        </button>
      </div>
      {!isAndroid() && (
        <p className="mt-1.5 text-[11px] text-yellow-900/70">
          On iPhone: tap the ••• menu at the top right, then &ldquo;Open in browser&rdquo;.
        </p>
      )}
    </div>
  );
}

/**
 * Drop-off location picker for checkout. Auto-centres on the customer's current
 * position, then lets them click or drag to set the exact delivery point — this
 * drives the distance-based delivery fee (store pin → drop-off).
 */
export function LocationPicker({
  value, onChange, height = 220, kind = 'dropoff', label,
}: {
  value: LatLngValue | null;
  onChange: (v: LatLngValue) => void;
  height?: number;
  /** Which end of the trip this pin is — drives its colour and its wording. */
  kind?: 'dropoff' | 'store';
  /** Overrides the default heading above the map. */
  label?: string;
}) {
  const isStore = kind === 'store';
  const pinIcon = isStore ? storePin : dropPin;
  const heading = label ?? (isStore ? 'Where to buy' : 'Delivery location');
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const placeRef = useRef<((lat: number, lng: number, tell?: boolean) => void) | null>(null);
  const [locating, setLocating] = useState(false);
  // Silence was the bug: a failed request just put the button back and said
  // nothing, so on iPhone it read as a dead button.
  const [geoNote, setGeoNote] = useState<string | null>(null);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const start: L.LatLngTuple = value ? [value.lat, value.lng] : DEFAULT_CENTER;
    const map = L.map(elRef.current).setView(start, value ? 16 : 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
    }).addTo(map);

    // `tell` is false when the move came *from* the parent — announcing it back
    // would bounce the value round the loop forever.
    const place = (lat: number, lng: number, tell = true) => {
      if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
      else {
        const m = L.marker([lat, lng], { icon: pinIcon, draggable: true }).addTo(map);
        m.on('dragend', () => {
          const p = m.getLatLng();
          onChangeRef.current({ lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) });
        });
        markerRef.current = m;
      }
      if (tell) onChangeRef.current({ lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
    };
    placeRef.current = place;

    if (value) place(value.lat, value.lng, false);
    map.on('click', (e: L.LeafletMouseEvent) => place(e.latlng.lat, e.latlng.lng));
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 0);

    // Centre on the device only for a drop-off. A store is somewhere else by
    // definition — but starting near the customer beats starting on Manila.
    //
    // Only when permission is already granted. iOS shows its permission sheet
    // once and remembers a dismissal, and spending that single prompt on a map
    // the customer never asked to move is how "Use my location" is already dead
    // by the time they press it.
    if (!value) {
      void loadServiceCentre().then(() => {
        // Still no pin and still on the fallback? Move to where we actually deliver.
        if (mapRef.current && !markerRef.current) mapRef.current.setView(DEFAULT_CENTER, 13);
      });
      void locationAlreadyGranted().then((granted) => {
        if (!granted || !mapRef.current) return;
        setLocating(true);
        locateOnce()
          .then((fix) => { map.setView([fix.lat, fix.lng], 16); })
          .catch(() => { /* it centred on the fallback; the button still works */ })
          .finally(() => setLocating(false));
      });
    }

    return () => { map.remove(); mapRef.current = null; markerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Follow a pin that arrives from outside — a saved address loading, or the
   * customer switching which one they're delivering to.
   *
   * Without this the map was built once and never moved again: the form knew
   * the right coordinates and showed "📍 pin set", while the map underneath sat
   * on the fallback centre with no marker at all. Tapping that map to "fix" it
   * then wrote a pin from the wrong part of the province.
   */
  useEffect(() => {
    if (!mapRef.current || !placeRef.current) return;
    // Cleared from outside — take the pin off the map too, or it goes on
    // pointing at an address the form no longer holds.
    if (!value) {
      if (markerRef.current) { markerRef.current.remove(); markerRef.current = null; }
      return;
    }
    if (samePoint(markerRef.current?.getLatLng() ?? null, value)) return;
    placeRef.current(value.lat, value.lng, false);
    mapRef.current.setView([value.lat, value.lng], 16);
  }, [value?.lat, value?.lng]);  // eslint-disable-line react-hooks/exhaustive-deps

  async function useMyLocation() {
    setLocating(true); setGeoNote(null);
    try {
      const { lat, lng, warning } = await locateOnce();
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
      onChangeRef.current({ lat, lng });
      // A fix can succeed and still be useless — a kilometre-wide guess is a
      // barangay, not a doorstep.
      setGeoNote(warning);
    } catch (e) {
      setGeoNote(e instanceof Error ? e.message : String(e));
    } finally {
      setLocating(false);
    }
  }

  return (
    <div>
      <InAppBrowserNotice />
      <div className="mb-2 flex items-center justify-between">
        <span className={`text-sm font-medium ${isStore ? 'text-brand-purple' : ''}`}>{heading}</span>
        {!isStore && (
          <button type="button" onClick={() => void useMyLocation()}
            className="rounded-lg bg-brand-purple px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
            disabled={locating}>
            {locating ? 'Locating…' : '📍 Use my location'}
          </button>
        )}
      </div>
      <div ref={elRef} style={{ height }}
        className={`w-full overflow-hidden rounded-lg ring-1 ${isStore ? 'ring-2 ring-brand-purple/40' : 'ring-black/10'}`} />
      {geoNote && (
        <p className="mt-1.5 rounded-lg bg-brand-yellow/25 px-3 py-2 text-xs text-yellow-900">{geoNote}</p>
      )}
      <div className="mt-1.5 flex items-start justify-between gap-2">
        <p className="text-xs text-black/50">
          {isStore
            ? value
              ? 'Wrong spot? Drag the map or tap again to move the store pin.'
              : 'Drag the map and tap to drop a pin on the store you want us to buy from.'
            : value
              ? 'Wrong spot? Tap the map or drag the pin to move your drop-off.'
              : 'Tap the map (or use your location) to set your drop-off point.'}
        </p>
        {value && (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            isStore ? 'bg-brand-purple/10 text-brand-purple' : 'bg-brand-green/15 text-green-800'}`}>
            📍 pin set
          </span>
        )}
      </div>
    </div>
  );
}
