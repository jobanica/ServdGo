/**
 * Incoming-order notifications.
 *
 * Two layers:
 *  - Realtime `postgres_changes` on the order queue — riders see new orders live
 *    while the app is open (this module).
 *  - Push (FCM/APNs) for when the app is closed — device tokens are stored here;
 *    the actual send is a server-side Edge Function (see supabase/functions).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface NewOrderEvent {
  id: string;
  service_type: 'food' | 'pabili' | 'padala';
  delivery_fee: number;
  commission_amount: number;
}

/**
 * Subscribe to new pending orders entering the pool. Fires `onOrder` for each
 * INSERT with status 'pending'. Returns an unsubscribe function.
 */
export function subscribeToNewOrders(
  db: SupabaseClient,
  onOrder: (order: NewOrderEvent) => void,
): () => void {
  const channel = db
    .channel('pool:new-orders')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'orders', filter: 'status=eq.pending' },
      (payload) => onOrder(payload.new as NewOrderEvent),
    )
    .subscribe();
  return () => { void db.removeChannel(channel); };
}

/** Upsert a rider's device push token (FCM/APNs). */
export async function saveRiderPushToken(
  db: SupabaseClient,
  riderId: string,
  token: string,
  platform: 'android' | 'ios' = 'android',
) {
  const { error } = await db
    .from('rider_push_tokens')
    .upsert({ rider_id: riderId, token, platform, updated_at: new Date().toISOString() },
      { onConflict: 'rider_id,token' });
  if (error) throw error;
}
