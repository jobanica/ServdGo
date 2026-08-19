import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** Renders a QR for `payload` (encoded locally, no network). */
export function Qr({ payload, size = 160 }: { payload: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(payload, { width: size, margin: 1 })
      .then((url) => { if (alive) setSrc(url); })
      .catch(() => { if (alive) setSrc(null); });
    return () => { alive = false; };
  }, [payload, size]);

  if (!src) return <div style={{ width: size, height: size }} className="animate-pulse rounded bg-black/5" />;
  return <img src={src} width={size} height={size} alt="Payment QR" className="rounded" />;
}
