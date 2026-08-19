import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPadalaOrderRow, advanceOrderStatus, type PadalaRequestInput } from './padala.ts';

const base: PadalaRequestInput = {
  customerId: 'cust-1',
  customerContact: '09171234567',
  deliveryFee: 40,
  feePayer: 'sender',
  itemDescription: 'Documents envelope',
  pickup: { contact: '09170000001', lat: 14.6, lng: 121.0 },
  dropoff: { contact: '09170000002' },
  notes: '  handle with care  ',
};

test('builds a padala row with 15% commission on the delivery fee', () => {
  const row = buildPadalaOrderRow(base);
  assert.equal(row.service_type, 'padala');
  assert.equal(row.status, 'pending');
  assert.equal(row.delivery_fee, 40);
  assert.equal(row.goods_cost, 0);
  assert.equal(row.store_fee_total, 0);
  assert.equal(row.commission_amount, 6); // 40 * 0.15
});

test('trims description and notes; empty notes become null', () => {
  const row = buildPadalaOrderRow({ ...base, notes: '   ' });
  assert.equal(row.notes, null);
  const row2 = buildPadalaOrderRow(base);
  assert.equal(row2.notes, 'handle with care');
});

test('missing dropoff coordinates default to null', () => {
  const row = buildPadalaOrderRow(base);
  assert.equal(row.dropoff_lat, null);
  assert.equal(row.pickup_lat, 14.6);
});

test('rejects an empty item description', () => {
  assert.throws(() => buildPadalaOrderRow({ ...base, itemDescription: '  ' }), /itemDescription/);
});

test('rejects a negative delivery fee', () => {
  assert.throws(() => buildPadalaOrderRow({ ...base, deliveryFee: -1 }), /non-negative/);
});

test('advanceOrderStatus rejects an illegal transition before any I/O', async () => {
  // A fake client that would throw if actually called — proving the guard
  // blocks the transition before touching the database.
  const db: any = {
    from() {
      throw new Error('db should not be touched on an illegal transition');
    },
  };
  await assert.rejects(
    advanceOrderStatus(db, { id: 'o1', service_type: 'padala', status: 'accepted' }, 'preparing'),
    /Illegal transition/,
  );
});

test('advanceOrderStatus allows a legal padala transition', async () => {
  const calls: string[] = [];
  const db: any = {
    from(table: string) {
      calls.push(table);
      return {
        update() {
          return { eq: async () => ({ error: null }) };
        },
        insert: async () => ({ error: null }),
      };
    },
  };
  await advanceOrderStatus(db, { id: 'o1', service_type: 'padala', status: 'accepted' }, 'picked_up');
  assert.deepEqual(calls, ['orders', 'order_status_events']);
});
