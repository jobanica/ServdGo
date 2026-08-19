/**
 * Order chat between the customer and the assigned rider.
 * Messages persist in `order_messages`; new ones arrive live via Realtime.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface OrderMessage {
  id: string;
  order_id: string;
  sender_profile: string;
  sender_role: 'customer' | 'rider';
  body: string | null;
  image_url: string | null;
  created_at: string;
}

/** Load an order's message history (oldest first). */
export async function listOrderMessages(db: SupabaseClient, orderId: string): Promise<OrderMessage[]> {
  const { data, error } = await db
    .from('order_messages')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as OrderMessage[];
}

/** Post a message to an order thread as the current user. A photo may travel alone. */
export async function sendOrderMessage(
  db: SupabaseClient,
  orderId: string,
  role: 'customer' | 'rider',
  body: string,
  imageUrl?: string | null,
): Promise<void> {
  const text = body.trim();
  if (!text && !imageUrl) return;
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error('not signed in');
  const { error } = await db.from('order_messages').insert({
    order_id: orderId,
    sender_profile: user.id,
    sender_role: role,
    body: text || null,
    image_url: imageUrl ?? null,
  });
  if (error) throw error;
}

/** Upload a chat photo to the public bucket and return its URL. */
export async function uploadChatPhoto(db: SupabaseClient, orderId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `chat-photos/${orderId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await db.storage.from('store-assets')
    .upload(path, file, { upsert: false, contentType: file.type || undefined });
  if (error) throw error;
  return db.storage.from('store-assets').getPublicUrl(path).data.publicUrl;
}

/** The rider says they're at the door. Posts into the thread the customer watches. */
export async function riderMarkArrived(db: SupabaseClient, orderId: string): Promise<void> {
  const { error } = await db.rpc('rider_mark_arrived', { p_order_id: orderId });
  if (error) throw error;
}

/**
 * Subscribe to new messages on an order thread. Returns an unsubscribe fn.
 * `channelKey` lets separate subscribers (e.g. an open thread vs an unread
 * badge) use distinct channel names on the same client.
 */
export function subscribeOrderMessages(
  db: SupabaseClient,
  orderId: string,
  onMessage: (m: OrderMessage) => void,
  channelKey = 'chat',
): () => void {
  const channel = db
    .channel(`${channelKey}:order:${orderId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'order_messages', filter: `order_id=eq.${orderId}` },
      (payload) => onMessage(payload.new as OrderMessage),
    )
    .subscribe();
  return () => { void db.removeChannel(channel); };
}
