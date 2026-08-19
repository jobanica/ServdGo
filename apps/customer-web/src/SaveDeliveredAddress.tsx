import { useMemo, useState } from 'react';
import { isNewAddress, type SavedAddress } from '@servdgo/shared';
import type { CustomerOrder } from '@servdgo/supabase';
import { SaveAddressPrompt, useSavedAddresses } from './AddressChooser.tsx';

/**
 * Asked once, after a delivery lands somewhere the customer hasn't saved.
 *
 * The moment they know a pin was right is when the order arrives at it — not
 * at checkout, where it would just be another decision in the way. Turned down
 * once, it stays down for that order.
 */
const DISMISSED_KEY = 'ebd.customer.addressPromptDismissed';

function dismissed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function dismiss(orderId: string): void {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed(), orderId].slice(-50))); }
  catch { /* private mode — it'll ask once more, which is survivable */ }
}

export function SaveDeliveredAddress({ orders, onSaved }: {
  orders: CustomerOrder[];
  onSaved: () => void | Promise<void>;
}) {
  const saved = useSavedAddresses();
  const [skipped, setSkipped] = useState<string[]>(dismissed);

  // The most recent delivery that went somewhere new and hasn't been answered.
  const candidate = useMemo(() => {
    if (!saved.loaded) return null;
    const asSaved: SavedAddress[] = saved.addresses;
    return orders.find((o) =>
      o.status === 'delivered'
      && !skipped.includes(o.id)
      // A gift went to someone else's door; that isn't the customer's address.
      && !o.recipient_contact
      && isNewAddress(asSaved, {
        pin: o.delivery_lat != null && o.delivery_lng != null
          ? { lat: o.delivery_lat, lng: o.delivery_lng } : null,
        address: o.delivery_address,
      })) ?? null;
  }, [orders, saved.addresses, saved.loaded, skipped]);

  if (!candidate) return null;

  return (
    <SaveAddressPrompt
      pin={candidate.delivery_lat != null && candidate.delivery_lng != null
        ? { lat: candidate.delivery_lat, lng: candidate.delivery_lng } : null}
      text={candidate.delivery_address ?? ''}
      area={candidate.area_province && candidate.area_city && candidate.area_barangay
        ? { province: candidate.area_province, city: candidate.area_city, barangay: candidate.area_barangay }
        : null}
      contactName={candidate.customer_name}
      contactPhone={candidate.customer_contact}
      addresses={saved.addresses}
      customerId={saved.customerId}
      onSaved={async () => { dismiss(candidate.id); setSkipped(dismissed); await saved.reload(); await onSaved(); }}
      onDismiss={() => { dismiss(candidate.id); setSkipped(dismissed); }}
    />
  );
}
