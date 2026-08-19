import type { OrderStatus, ServiceType, LedgerEntry, PaymentMethod, EarningRecord } from '@servdgo/shared';
import type { OrderItemStatus, OrderAddon, RiderPinCorrectionResult, BuyStorePinResult } from '@servdgo/supabase';

export type { OrderAddon };

/** The order shape the rider UI works with (subset of the orders row). */
export interface RiderOrder {
  id: string;
  service_type: ServiceType;
  status: OrderStatus;
  /** When the customer placed it — decides its place in the request queue. */
  createdAt: string;
  payment_method: PaymentMethod;
  payment_status: 'unpaid' | 'paid';
  customerName: string | null;
  recipientName: string | null;
  recipientContact: string | null;
  delivery_fee: number;
  store_fee_total: number;
  convenience_fee: number;
  goods_cost: number;
  commission_amount: number;
  customer_contact: string;
  item_description: string | null;
  estimated_amount: number | null;
  budget_cap: number | null;
  actual_amount: number | null;
  /** Pabili: the rider's photo of the store receipt backing actual_amount. */
  goodsReceiptUrl: string | null;
  store_contact: string | null;
  /** Linked store(s) for the order, so the rider can call the restaurant. */
  stores: { id: string | null; name: string | null; contact: string | null; lat: number | null; lng: number | null }[];
  /** Pabili: ad-hoc stores to visit. Each past the first billed a store fee. */
  buyStores: { name: string; lat: number | null; lng: number | null }[];
  /** What the customer ordered (store_id links each item to its store). */
  items: {
    id: string | null; store_id: string | null;
    /** The menu entry behind this line, when there is one — pabili lines and
        rider-suggested replacements have none, so nothing to keep in step. */
    menuItemId: string | null;
    /** Pabili: index into `buyStores` for where this item comes from. */
    buyStoreIndex: number | null;
    name: string; qty: number; unitPrice: number; notes: string | null;
    /** Operator mark-up inside unitPrice — the rider pays the rest at the counter. */
    markup: number;
    status: OrderItemStatus; replacesItemId: string | null;
  }[];
  /** Where the rider buys/collects (pabili & padala pin the source). */
  pickupLat: number | null;
  pickupLng: number | null;
  /** Customer drop-off coordinates (for the tracking map / navigation). */
  deliveryLat: number | null;
  deliveryLng: number | null;
  /** Written addresses — the pin gets them to the street, this to the door. */
  deliveryAddress: string | null;
  pickupAddress: string | null;
  /** Set once the rider has told the customer they're at the door. */
  arrivedAt: string | null;
  notes: string | null;
  /** Proof of a GCash-to-rider payment (uploaded by the customer, if any). */
  paymentReceiptUrl: string | null;
  paymentReference: string | null;
  paymentConfirmedAt: string | null;
  /** Released by another rider — prioritised in the pool. */
  isTransfer: boolean;
  transferReason: string | null;
  /** The previous rider already has the goods; coordinate a hand-over. */
  transferHadGoods: boolean;
  transferredFromName: string | null;
  transferredFromContact: string | null;
}

/** Abstraction the UI depends on — implemented for live Supabase and preview. */
export interface RiderData {
  readonly live: boolean;
  getOnline(): Promise<boolean>;
  setOnline(online: boolean): Promise<boolean>;
  getOpenOrders(): Promise<RiderOrder[]>;
  getActiveOrders(): Promise<RiderOrder[]>;
  getLedger(): Promise<LedgerEntry[]>;
  /** Completed deliveries between two business days (inclusive), for earnings. */
  getEarnings(fromDay: string, toDay: string): Promise<EarningRecord[]>;
  accept(orderId: string): Promise<void>;
  /** Pass on a pool request. Recorded, so the skip survives a new device. */
  declineOrder(orderId: string): Promise<void>;
  /** Requests this rider has already passed on. */
  getDeclinedOrderIds(): Promise<string[]>;
  releaseOrder(orderId: string, reason?: string): Promise<void>;
  /** Tell the customer you're outside. Alerts their phone.  */
  markArrived(orderId: string): Promise<void>;
  confirmPayment(orderId: string, note?: string): Promise<void>;
  /** Store ran out: drop the item from the bill (no customer approval needed). */
  markSoldOut(itemId: string): Promise<void>;
  /** Pabili: put a store's map pin where the shop really is. Correcting the
      first store re-quotes the delivery fee from it. */
  setBuyStoreLocation(
    orderId: string, index: number, at: { lat: number; lng: number },
  ): Promise<BuyStorePinResult>;
  /** The shelf price differs from ours: record what the store actually charges. */
  correctItemPrice(itemId: string, unitPrice: number): Promise<void>;
  /** Put the drop-off pin where the customer really is; re-quotes the fee by distance. */
  correctDeliveryPin(
    orderId: string, at: { lat: number; lng: number }, address?: string,
  ): Promise<RiderPinCorrectionResult>;
  /** Offer something else instead — stays off the bill until the customer agrees. */
  proposeReplacement(itemId: string, name: string, qty: number, unitPrice: number): Promise<void>;
  /** Extra-stop requests the customer has made on this order. */
  getAddons(orderId: string): Promise<OrderAddon[]>;
  /** Take on (or turn down) an extra stop. Accepting bills it and adds commission. */
  respondToAddon(addonId: string, accept: boolean): Promise<void>;
  advance(order: RiderOrder, next: OrderStatus): Promise<void>;
  setActual(order: RiderOrder, amount: number, receiptUrl?: string): Promise<{ overCap: boolean }>;
  /** Upload the store receipt photo backing a pabili total; returns its URL. */
  uploadGoodsReceipt(orderId: string, file: File): Promise<string>;
  settle(businessDay: string, amount: number, extra?: { reference?: string; receiptUrl?: string }): Promise<void>;
}
