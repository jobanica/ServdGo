import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addedStores,
  commission,
  counterTotal,
  riderEarnings,
  storeFeeTotal,
  orderCost,
  distanceDeliveryFee,
  resolveDeliveryFee,
  DEFAULT_FEE_CONFIG,
  DEFAULT_DISTANCE_FEE_CONFIG,
  type FeeConfig,
  type DistanceFeeConfig,
} from './pricing.ts';

test('addedStores counts only stores beyond the first', () => {
  assert.equal(addedStores(0), 0);
  assert.equal(addedStores(1), 0);
  assert.equal(addedStores(2), 1);
  assert.equal(addedStores(3), 2);
});

test('locked formula: DF 50 + 3 stores => commission 15', () => {
  // base = 50 + 25*2 = 100 ; 100 * 0.15 = 15
  assert.equal(commission({ deliveryFee: 50, storeCount: 3 }), 15);
});

test('riderEarnings = fees collected minus commission', () => {
  // DF 50, no added stores, no convenience, commission 7.5 → earns 42.5
  assert.equal(riderEarnings({ deliveryFee: 50, commission: 7.5 }), 42.5);
  // DF 50 + 1 added store (₱25) → commission 11.25; convenience 20 to rider.
  // earn = 50 + 25 + 20 − 11.25 = 83.75
  assert.equal(riderEarnings({ deliveryFee: 50, storeFeeTotal: 25, convenienceFee: 20, commission: 11.25 }), 83.75);
});

test('single-store food order: DF 50 => commission 7.5', () => {
  // base = 50 + 25*0 = 50 ; 50 * 0.15 = 7.5
  assert.equal(commission({ deliveryFee: 50, storeCount: 1 }), 7.5);
});

test('padala (delivery fee only, no store): 15% of DF', () => {
  assert.equal(commission({ deliveryFee: 40, storeCount: 0 }), 6);
});

test('storeFeeTotal uses per-store fee for added stores', () => {
  assert.equal(storeFeeTotal(3, DEFAULT_FEE_CONFIG), 50);
  assert.equal(storeFeeTotal(1, DEFAULT_FEE_CONFIG), 0);
});

test('convenience fee never changes commission (it is the rider\'s)', () => {
  const config: FeeConfig = { ...DEFAULT_FEE_CONFIG, convenienceFee: 20 };
  // base = 50 + 25*2 = 100 ; 100 * 0.15 = 15 — the ₱20 convenience fee is excluded
  assert.equal(commission({ deliveryFee: 50, storeCount: 3 }, config), 15);
});

test('editable commission rate is honored', () => {
  const config: FeeConfig = { ...DEFAULT_FEE_CONFIG, commissionRate: 0.2 };
  assert.equal(commission({ deliveryFee: 100, storeCount: 1 }, config), 20);
});

test('orderCost: goods are a pass-through, excluded from commission', () => {
  const b = orderCost({ deliveryFee: 50, storeCount: 3, goodsCost: 500 });
  // customer pays goods + DF + store fees + convenience
  assert.equal(b.customerTotal, 500 + 50 + 50 + 0);
  // commission untouched by the 500 goods cost
  assert.equal(b.commission, 15);
  assert.equal(b.storeFeeTotal, 50);
});

test('orderCost: convenience pass-through is added to customer total', () => {
  const config: FeeConfig = { ...DEFAULT_FEE_CONFIG, convenienceFee: 20 };
  const b = orderCost({ deliveryFee: 50, storeCount: 1, goodsCost: 200 }, config);
  assert.equal(b.customerTotal, 200 + 50 + 0 + 20);
  assert.equal(b.commission, 7.5);
});

test('no floating point drift in rounding', () => {
  // 0.1-style inputs should still round cleanly to centavos
  const b = orderCost({ deliveryFee: 10.1, storeCount: 1, goodsCost: 0.2 });
  assert.equal(b.customerTotal, 10.3);
});

test('distanceDeliveryFee: within base distance is just the base fare', () => {
  assert.equal(distanceDeliveryFee(0), 50);
  assert.equal(distanceDeliveryFee(1.5), 50);
  assert.equal(distanceDeliveryFee(2), 50); // exactly at the base km
});

test('distanceDeliveryFee: charges per km beyond the base distance', () => {
  // 5 km → 50 + 10 × (5 − 2) = 80
  assert.equal(distanceDeliveryFee(5), 80);
  // 2.5 km → 50 + 10 × 0.5 = 55
  assert.equal(distanceDeliveryFee(2.5), 55);
});

test('distanceDeliveryFee: honours a custom rate config', () => {
  const config: DistanceFeeConfig = { baseFare: 40, baseKm: 1, perKm: 12 };
  // 4 km → 40 + 12 × (4 − 1) = 76
  assert.equal(distanceDeliveryFee(4, config), 76);
});

test('distanceDeliveryFee: guards bad distances', () => {
  assert.equal(distanceDeliveryFee(-3), 50);          // negative → base fare
  assert.equal(distanceDeliveryFee(NaN), 50);         // NaN → base fare
  assert.equal(DEFAULT_DISTANCE_FEE_CONFIG.baseFare, 50);
});

const rates = DEFAULT_DISTANCE_FEE_CONFIG; // base 50, baseKm 2, perKm 10
// ~3 km apart in Metro Manila (0.027° of latitude ≈ 3 km).
const store = { lat: 14.600, lng: 121.000 };
const dropoff3km = { lat: 14.573, lng: 121.000 };

test('resolveDeliveryFee: flat model ignores distance', () => {
  const fee = resolveDeliveryFee({
    model: 'flat', flatFee: 50, distanceConfig: rates,
    storeLocations: [store], dropoff: dropoff3km,
  });
  assert.equal(fee, 50);
});

test('resolveDeliveryFee: per_km charges on the farthest store leg', () => {
  const near = { lat: 14.591, lng: 121.000 }; // ~1 km
  const fee = resolveDeliveryFee({
    model: 'per_km', flatFee: 50, distanceConfig: rates,
    storeLocations: [near, store], dropoff: dropoff3km,
  });
  // farthest leg ≈ 3 km → 50 + 10 × (3 − 2) ≈ 60 (allow ±1 for geo rounding)
  assert.ok(Math.abs(fee - 60) <= 1, `expected ~60, got ${fee}`);
});

test('resolveDeliveryFee: falls back to flat when drop-off missing', () => {
  const fee = resolveDeliveryFee({
    model: 'per_km', flatFee: 55, distanceConfig: rates,
    storeLocations: [store], dropoff: null,
  });
  assert.equal(fee, 55);
});

test('resolveDeliveryFee: falls back to flat when no store is pinned', () => {
  const fee = resolveDeliveryFee({
    model: 'per_km', flatFee: 55, distanceConfig: rates,
    storeLocations: [null, undefined], dropoff: dropoff3km,
  });
  assert.equal(fee, 55);
});

test('the convenience fee is flat — extra stops are billed by the store fee alone', () => {
  const cfg = { perStoreFee: 25, commissionRate: 0.15, convenienceFee: 35 };
  const one = orderCost({ deliveryFee: 80, storeCount: 1, goodsCost: 600 }, cfg);
  const three = orderCost({ deliveryFee: 80, storeCount: 3, goodsCost: 600 }, cfg);
  assert.equal(one.convenienceFee, 35);
  assert.equal(three.convenienceFee, 35);      // not 105
  assert.equal(three.storeFeeTotal, 50);       // the two extra stops, billed once each
  assert.equal(three.customerTotal, 765);
  // Commission is on delivery + store fees only — the convenience fee is the rider's.
  assert.equal(three.commission, 19.5);
});

test('counterTotal is what the shop is owed, not what the customer is billed', () => {
  // The screenshot case: Angel's Burger ₱45 + ₱70, Andoks ₱95 + ₱150.
  assert.equal(counterTotal([
    { qty: 1, unitPrice: 45 }, { qty: 1, unitPrice: 70 },
  ]), 115);
  assert.equal(counterTotal([
    { qty: 1, unitPrice: 95 }, { qty: 2, unitPrice: 75 },
  ]), 245);
});

test('counterTotal strips our mark-up — the shop gets its shelf price', () => {
  // Billed ₱130 each, ₱10 of which is ours: the counter is owed ₱240 for two.
  assert.equal(counterTotal([{ qty: 2, unitPrice: 130, markup: 10 }]), 240);
});

test('counterTotal skips what is not being bought', () => {
  const lines = [
    { qty: 1, unitPrice: 100 },
    { qty: 1, unitPrice: 60, status: 'sold_out' },
    { qty: 1, unitPrice: 80, status: 'proposed' },
  ];
  assert.equal(counterTotal(lines), 100);
});
