import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lineUnitPrice,
  lineTotal,
  goodsCost,
  distinctStoreCount,
  withinStoreLimit,
  summarizeCart,
  type CartLine,
} from './cart.ts';

const lines: CartLine[] = [
  { storeId: 'A', name: 'Burger', unitPrice: 120, qty: 2,
    options: [{ name: 'Cheese', priceDelta: 15 }] },
  { storeId: 'A', name: 'Fries', unitPrice: 60, qty: 1 },
  { storeId: 'B', name: 'Milk tea', unitPrice: 90, qty: 3 },
];

test('lineUnitPrice includes options', () => {
  assert.equal(lineUnitPrice(lines[0]!), 135); // 120 + 15
  assert.equal(lineUnitPrice(lines[1]!), 60);
});

test('lineTotal multiplies by qty', () => {
  assert.equal(lineTotal(lines[0]!), 270); // 135 * 2
  assert.equal(lineTotal(lines[2]!), 270); // 90 * 3
});

test('goodsCost sums all lines', () => {
  assert.equal(goodsCost(lines), 270 + 60 + 270);
});

test('distinctStoreCount counts unique stores', () => {
  assert.equal(distinctStoreCount(lines), 2); // A, B
});

test('withinStoreLimit enforces max 3 stores', () => {
  const four: CartLine[] = ['A', 'B', 'C', 'D'].map((storeId) => ({
    storeId, name: 'x', unitPrice: 10, qty: 1,
  }));
  assert.equal(withinStoreLimit(lines), true);
  assert.equal(withinStoreLimit(four), false);
});

test('summarizeCart: 2 stores => 1 added store fee, commission on fees only', () => {
  const b = summarizeCart(lines, 50);
  // goods = 600 (pass-through), store fee = 25*1 = 25, DF = 50
  assert.equal(b.goodsCost, 600);
  assert.equal(b.storeFeeTotal, 25);
  assert.equal(b.customerTotal, 600 + 50 + 25 + 0);
  // commission base = 50 + 25 = 75 ; * 0.15 = 11.25
  assert.equal(b.commission, 11.25);
});

test('summarizeCart single-store cart has no store fee', () => {
  const single: CartLine[] = [{ storeId: 'A', name: 'x', unitPrice: 100, qty: 1 }];
  const b = summarizeCart(single, 50);
  assert.equal(b.storeFeeTotal, 0);
  assert.equal(b.commission, 7.5); // 50 * 0.15
});
