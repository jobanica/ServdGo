/**
 * Customer welcome / landing screen — brand-first splash shown before the app.
 * Uses the EBD logo and brand palette (green hero with a subtle sunburst).
 */
export function Welcome({ onOrder, onTrack }: { onOrder: () => void; onTrack: () => void }) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-brand-green text-white">
      {/* Sunburst rays + radial glow behind the content */}
      <div className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(circle at 50% 34%, #85d13c 0%, #6DBE22 55%, #57a51b 100%)' }} />
      <div className="pointer-events-none absolute inset-0 opacity-[0.14]"
        style={{ background: 'repeating-conic-gradient(from 0deg at 50% 34%, #ffffff 0deg 7deg, transparent 7deg 15deg)' }} />

      <div className="relative mx-auto flex w-full max-w-md flex-1 flex-col px-6 pb-8 pt-10">
        {/* Top pill */}
        <div className="flex justify-center">
          <span className="rounded-full bg-white px-4 py-1.5 text-sm font-extrabold text-brand-green shadow-sm">
            🛵 Food • Pabili • Padala
          </span>
        </div>

        {/* Headline */}
        <h1 className="mt-6 text-center text-5xl font-black leading-[1.05] tracking-tight drop-shadow-sm">
          Welcome to<br />Easy Buy<br /><span className="text-brand-yellow">Delivery</span>
        </h1>

        {/* Logo medallion */}
        <div className="flex flex-1 items-center justify-center py-6">
          <div className="flex h-52 w-52 items-center justify-center rounded-full bg-white/95 p-4 shadow-2xl ring-8 ring-white/20">
            <img src="/icons/pwa-512x512.png" alt="Easy Buy Delivery" className="h-full w-full object-contain" />
          </div>
        </div>

        {/* CTAs */}
        <div className="space-y-3">
          <button onClick={onOrder}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-white py-4 text-base font-extrabold text-brand-green shadow-lg transition active:scale-[.99]">
            🛒 Order now
          </button>
          <button onClick={onTrack}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-white/15 py-4 text-base font-bold text-white ring-1 ring-white/40 transition active:scale-[.99]">
            📍 Track a delivery
          </button>
        </div>

        <p className="mt-5 text-center text-xs leading-relaxed text-white/85">
          Order food, run errands with <b>Pabili</b>, or send a package with <b>Padala</b> —
          delivered across your town by one rider.
        </p>
      </div>
    </div>
  );
}
