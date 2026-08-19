import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectibleAtDoor,
  generatesSettlementBalance,
} from './payments.ts';
import { orderCost } from './pricing.ts';

// Food-style order: goods 280 pass-through, DF 50, 1 store.
const food = orderCost({ deliveryFee: 50, storeCount: 1, goodsCost: 280 });
// Padala-style: no goods.
const padala = orderCost({ deliveryFee: 40, storeCount: 0, goodsCost: 0 });

test('COD collects the full customer total', () => {
  assert.equal(collectibleAtDoor(food, 'cod'), food.customerTotal); // 330
});

test('online collects the full total too — no gateway takes it first', () => {
  assert.equal(collectibleAtDoor(food, 'online'), food.customerTotal);
  assert.equal(collectibleAtDoor(padala, 'online'), padala.customerTotal);
});

test('rider_qr collects nothing at the door', () => {
  assert.equal(collectibleAtDoor(food, 'rider_qr'), 0);
});

test('every method generates a settlement balance', () => {
  assert.equal(generatesSettlementBalance('cod'), true);
  assert.equal(generatesSettlementBalance('rider_qr'), true);
  // Regression: this was false, so an online delivery booked no commission and
  // the operator's cut was never collected from anyone.
  assert.equal(generatesSettlementBalance('online'), true);
});
