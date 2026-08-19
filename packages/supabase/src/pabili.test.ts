import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPabiliOrderRow, updatePabiliActualAmount, type PabiliRequestInput } from './pabili.ts';

const base: PabiliRequestInput = {
  customerId: 'cust-1',
  customerContact: '09171234567',
  deliveryFee: 60,
  itemsDescription: '2x paracetamol, 1L milk',
  estimate: 500,
  cap: 600,
  where: 'Botica Central',
  notes: 'ring the bell',
};

test('builds a pabili row with estimate, cap, and 15% DF commission', () => {
  const row = buildPabiliOrderRow(base);
  assert.equal(row.service_type, 'pabili');
  assert.equal(row.estimated_amount, 500);
  assert.equal(row.budget_cap, 600);
  assert.equal(row.goods_cost, 0); // unknown until bought
  assert.equal(row.commission_amount, 9); // 60 * 0.15
});

test('folds where + notes into the notes field', () => {
  const row = buildPabiliOrderRow(base);
  assert.match(row.notes ?? '', /Buy at: Botica Central/);
  assert.match(row.notes ?? '', /ring the bell/);
});

test('rejects an empty items list and a cap below estimate', () => {
  assert.throws(() => buildPabiliOrderRow({ ...base, itemsDescription: ' ' }), /itemsDescription/);
  assert.throws(() => buildPabiliOrderRow({ ...base, cap: 400 }), /cap must be/);
});

test('updatePabiliActualAmount flags an over-cap spend', async () => {
  const updates: Record<string, unknown>[] = [];
  const db: any = {
    from() {
      return { update(v: Record<string, unknown>) { updates.push(v); return { eq: async () => ({ error: null }) }; } };
    },
  };
  const order = { id: 'o1', estimated_amount: 500, budget_cap: 600 };

  const within = await updatePabiliActualAmount(db, order, 550);
  assert.equal(within.overCap, false);

  const over = await updatePabiliActualAmount(db, order, 650);
  assert.equal(over.overCap, true);

  // goods_cost is synced to the actual amount for accurate collection
  assert.deepEqual(updates[0], { actual_amount: 550, goods_cost: 550 });
});

test('rejects a negative actual amount', async () => {
  const db: any = { from() { throw new Error('should not touch db'); } };
  await assert.rejects(
    updatePabiliActualAmount(db, { id: 'o1', estimated_amount: 500, budget_cap: 600 }, -5),
    /non-negative/,
  );
});
