import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * Renders the rider's payment QR. `payload` is whatever the customer's wallet
 * scans — in production the rider's GCash/Maya deep link or a platform payment
 * URL (open decision #6). Encoded locally, no network.
 */
export function Qr({ payload, size = 132 }: { payload: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(payload, { width: size, margin: 1 })
      .then((url) => { if (alive) setSrc(url); })
      .catch(() => { if (alive) setSrc(null); });
    return () => { alive = false; };
  }, [payload, size]);

  if (!src) return <div style={{ width: size, height: size }} className="animate-pulse rounded bg-black/5" />;
  return <img src={src} width={size} height={size} alt="Scan to pay" className="rounded" />;
}
