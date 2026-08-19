import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettlementRow } from './settlement.ts';

test('buildSettlementRow starts pending with optional method/reference', () => {
  const row = buildSettlementRow({
    riderId: 'r1', businessDay: '2026-07-16', amountDue: 42.5,
    method: 'gcash', reference: 'ABC123',
  });
  assert.deepEqual(row, {
    rider_id: 'r1',
    business_day: '2026-07-16',
    amount_due: 42.5,
    method: 'gcash',
    reference: 'ABC123',
    receipt_url: null,
    status: 'pending',
  });
});

test('missing method/reference default to null', () => {
  const row = buildSettlementRow({ riderId: 'r1', businessDay: '2026-07-16', amountDue: 10 });
  assert.equal(row.method, null);
  assert.equal(row.reference, null);
});

test('rejects a negative amount due', () => {
  assert.throws(
    () => buildSettlementRow({ riderId: 'r1', businessDay: '2026-07-16', amountDue: -1 }),
    /non-negative/,
  );
});
