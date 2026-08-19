import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordEarnings,
  shiftDay,
  presetRange,
  filterEarnings,
  normalizeRange,
  summarizeEarnings,
  type EarningRecord,
} from './earnings.ts';

const rec = (over: Partial<EarningRecord> = {}): EarningRecord => ({
  orderId: 'o1', businessDay: '2026-08-04', serviceType: 'food',
  deliveryFee: 50, storeFeeTotal: 0, convenienceFee: 0, commission: 7.5, ...over,
});

test('take-home is the fees collected less commission', () => {
  assert.equal(recordEarnings(rec()), 42.5);
  assert.equal(recordEarnings(rec({ storeFeeTotal: 25, convenienceFee: 20, commission: 11.25 })), 83.75);
});

test('shiftDay crosses month and year boundaries', () => {
  assert.equal(shiftDay('2026-08-04', -6), '2026-07-29');
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDay('2026-02-28', 1), '2026-03-01');
});

test('presets resolve against the given business day', () => {
  assert.deepEqual(presetRange('today', '2026-08-04'), { from: '2026-08-04', to: '2026-08-04' });
  assert.deepEqual(presetRange('week', '2026-08-04'), { from: '2026-07-29', to: '2026-08-04' });
  assert.deepEqual(presetRange('month', '2026-08-04'), { from: '2026-08-01', to: '2026-08-04' });
  assert.deepEqual(presetRange('all', '2026-08-04'), { from: '1970-01-01', to: '2026-08-04' });
});

test('filtering is inclusive at both ends', () => {
  const records = [
    rec({ orderId: 'a', businessDay: '2026-08-01' }),
    rec({ orderId: 'b', businessDay: '2026-08-02' }),
    rec({ orderId: 'c', businessDay: '2026-08-04' }),
  ];
  assert.deepEqual(
    filterEarnings(records, { from: '2026-08-01', to: '2026-08-02' }).map((r) => r.orderId),
    ['a', 'b'],
  );
  assert.equal(filterEarnings(records, { from: '2026-08-03', to: '2026-08-03' }).length, 0);
});

test('a backwards range reads as the span between the two days', () => {
  assert.deepEqual(normalizeRange({ from: '2026-08-04', to: '2026-08-01' }), { from: '2026-08-01', to: '2026-08-04' });
});

test('summary totals the range and groups by day, newest first', () => {
  const s = summarizeEarnings([
    rec({ orderId: 'a', businessDay: '2026-08-03' }),
    rec({ orderId: 'b', businessDay: '2026-08-04', deliveryFee: 60, commission: 9 }),
    rec({ orderId: 'c', businessDay: '2026-08-04', deliveryFee: 40, commission: 6 }),
  ]);
  assert.equal(s.deliveries, 3);
  assert.equal(s.earned, 42.5 + 51 + 34);
  assert.equal(s.commission, 22.5);
  assert.equal(s.gross, 150);
  assert.equal(s.perDelivery, 42.5);
  assert.deepEqual(s.byDay.map((d) => d.day), ['2026-08-04', '2026-08-03']);
  assert.deepEqual(s.byDay[0], { day: '2026-08-04', deliveries: 2, earned: 85, commission: 15 });
});

test('an empty range summarizes to zeros, not NaN', () => {
  const s = summarizeEarnings([]);
  assert.deepEqual(
    { earned: s.earned, deliveries: s.deliveries, perDelivery: s.perDelivery, byDay: s.byDay },
    { earned: 0, deliveries: 0, perDelivery: 0, byDay: [] },
  );
});
