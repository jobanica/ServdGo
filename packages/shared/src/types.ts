/**
 * Domain types shared across all frontends. These mirror the Supabase schema
 * enums (see supabase/migrations). Table row types can be generated with the
 * Supabase CLI once the project is linked; these are the hand-authored unions.
 */

export type ServiceType = 'food' | 'pabili' | 'padala';

export type OrderStatus =
  | 'pending'
  | 'accepted'
  | 'preparing'
  | 'picked_up'
  | 'on_the_way'
  | 'delivered'
  | 'cancelled';

export type PaymentMethod = 'cod' | 'online' | 'rider_qr';
export type PaymentStatus = 'unpaid' | 'paid';
export type FeePayer = 'sender' | 'receiver';
export type RiderApplicationStatus = 'pending' | 'approved' | 'rejected';
export type SettlementStatus = 'pending' | 'confirmed';
export type DeliveryFeeModel = 'flat' | 'per_km' | 'per_zone';
export type UserRole = 'customer' | 'rider' | 'admin';

/** Forward order-status transitions allowed in the happy path, by service. */
export const ORDER_FLOW: Record<ServiceType, OrderStatus[]> = {
  food: ['pending', 'accepted', 'preparing', 'picked_up', 'on_the_way', 'delivered'],
  pabili: ['pending', 'accepted', 'preparing', 'picked_up', 'on_the_way', 'delivered'],
  // No store prep step for point-to-point courier.
  padala: ['pending', 'accepted', 'picked_up', 'on_the_way', 'delivered'],
};

/** Is `next` a valid forward transition from `current` for this service? */
export function canTransition(
  service: ServiceType,
  current: OrderStatus,
  next: OrderStatus,
): boolean {
  if (next === 'cancelled') return current !== 'delivered';
  const flow = ORDER_FLOW[service];
  const i = flow.indexOf(current);
  const j = flow.indexOf(next);
  return i !== -1 && j === i + 1;
}
