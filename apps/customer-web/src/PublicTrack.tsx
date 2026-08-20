/**
 * "Where is my delivery" — for somebody with no account.
 *
 * A diner who ordered through a partner platform has no ServdGo login and never
 * will. Their tracking token is the whole credential, and the answer behind it
 * is deliberately narrow: the status, who is bringing it, and what is owed at
 * the door.
 *
 * This lived inside the edge function as server-rendered HTML until Supabase's
 * gateway made that impossible — it serves HTML from a function as text/plain
 * with nosniff, so the diner got a screenful of markup. The data was always
 * fine; the hosting was not. So the page is here, on a domain we own, and the
 * function still answers with the JSON it feeds on.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const STEPS = ['pending', 'accepted', 'preparing', 'picked_up', 'on_the_way', 'delivered'] as const;
const WORDS: Record<string, string> = {
  pending: 'Looking for a rider',
  accepted: 'A rider is on the way to collect it',
  preparing: 'Being prepared',
  picked_up: 'Collected',
  on_the_way: 'On the way to you',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

interface TrackData {
  status: string;
  from: string | null;
  dropoffAddress: string | null;
  amountDue: number;
  dropoff: { lat: number; lng: number } | null;
  rider: {
    name?: string; contact?: string; vehicle?: string;
    position?: { lat: number; lng: number; at: string } | null;
  } | null;
}

const pin = (bg: string, glyph: string) =>
  L.divIcon({
    className: '', iconSize: [30, 30], iconAnchor: [15, 15],
    html: `<div style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;
      border-radius:50%;background:${bg};box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,.4);
      font-size:15px">${glyph}</div>`,
  });

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? 'just now' : `${Math.round(s / 60)} min ago`;
}

/** The map, kept out of the render path so a redraw never rebuilds it. */
function RiderMap({ rider, dropoff }: {
  rider: { lat: number; lng: number }; dropoff: { lat: number; lng: number } | null;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: false, attributionControl: false })
      .setView([rider.lat, rider.lng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    markRef.current = L.marker([rider.lat, rider.lng], { icon: pin('#E8552F', '🛵') }).addTo(map);
    if (dropoff) {
      L.marker([dropoff.lat, dropoff.lng], { icon: pin('#1e1e1e', '📍') }).addTo(map);
      map.fitBounds(L.latLngBounds([[rider.lat, rider.lng], [dropoff.lat, dropoff.lng]]).pad(0.35));
    }
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; markRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Move the pin rather than redraw the map — the diner may have panned it.
  useEffect(() => { markRef.current?.setLatLng([rider.lat, rider.lng]); }, [rider.lat, rider.lng]);

  return <div ref={elRef} className="mt-3 h-64 w-full overflow-hidden rounded-xl bg-black/[0.06]" />;
}

export function PublicTrack({ token }: { token: string }) {
  const [data, setData] = useState<TrackData | null | 'missing'>(null);

  const load = useCallback(async () => {
    const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    if (!base) { setData('missing'); return; }
    try {
      const res = await fetch(`${base}/functions/v1/track?t=${encodeURIComponent(token)}`,
                             { headers: { accept: 'application/json' } });
      setData(res.ok ? (await res.json()) as TrackData : 'missing');
    } catch {
      // Keep whatever is on screen — a dropped request is not a lost delivery.
      setData((d) => (d === null ? 'missing' : d));
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (data === null) {
    return <Shell><p className="text-sm text-black/50">Finding your delivery…</p></Shell>;
  }
  if (data === 'missing') {
    return (
      <Shell>
        <h1 className="text-xl font-extrabold">This link is not valid</h1>
        <p className="mt-1 text-sm text-black/55">Ask the restaurant for a new tracking link.</p>
      </Shell>
    );
  }

  const done = STEPS.indexOf(data.status as typeof STEPS[number]);
  const pos = data.rider?.position ?? null;
  const carrying = data.status === 'picked_up' || data.status === 'on_the_way';

  return (
    <Shell>
      <p className="text-sm text-black/45">ServdGo</p>
      <h1 className="mt-1 text-2xl font-extrabold">{WORDS[data.status] ?? data.status}</h1>
      <p className="mt-1 text-sm text-black/55">
        From {data.from} to {data.dropoffAddress}
      </p>

      <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
        <ul>
          {STEPS.map((s, i) => {
            const on = done >= i && data.status !== 'cancelled';
            return (
              <li key={s} className={`flex items-center gap-3 py-1.5 ${on ? 'text-black' : 'text-black/35'}`}>
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${on ? 'bg-brand-orange' : 'bg-black/15'}`} />
                {WORDS[s]}
              </li>
            );
          })}
        </ul>
      </div>

      {data.rider?.name && (
        <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-sm text-black/45">Your rider</p>
          <p className="font-bold">
            {data.rider.name}{data.rider.vehicle ? ` · ${data.rider.vehicle}` : ''}
          </p>
          {data.rider.contact && (
            <a href={`tel:${data.rider.contact}`}
              className="mt-2 inline-block rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white">
              Call {data.rider.contact}
            </a>
          )}
          {pos
            ? <>
                <RiderMap rider={pos} dropoff={data.dropoff} />
                <p className="mt-2 text-xs text-black/45">Location updated {ago(pos.at)}</p>
              </>
            : carrying && (
                <p className="mt-3 text-xs text-black/45">
                  Waiting for your rider’s location — it appears here once their phone reports in.
                </p>
              )}
        </div>
      )}

      <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
        <p className="text-sm text-black/45">To pay on delivery</p>
        <p className="text-2xl font-extrabold">₱{Number(data.amountDue ?? 0).toFixed(2)}</p>
        <p className="text-sm text-black/45">Delivery only — the food is already paid for.</p>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f8f6f4] text-brand-ink">
      <div className="mx-auto max-w-md px-5 py-6">{children}</div>
    </div>
  );
}
