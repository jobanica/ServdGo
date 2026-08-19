import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRefusals, type RiderRequestEvent } from './riderEvents.ts';

const ev = (over: Partial<RiderRequestEvent> & { id: string; riderId: string }): RiderRequestEvent => ({
  riderName: `Rider ${over.riderId}`, orderId: `o-${over.id}`, kind: 'declined',
  reason: null, hadGoods: false, createdAt: '2026-08-04T02:00:00Z', order: null,
  ...over,
});

test('counts declines and transfers per rider', () => {
  const tally = summarizeRefusals([
    ev({ id: '1', riderId: 'a' }),
    ev({ id: '2', riderId: 'a' }),
    ev({ id: '3', riderId: 'a', kind: 'transferred', hadGoods: true }),
    ev({ id: '4', riderId: 'b', kind: 'transferred' }),
  ]);
  assert.deepEqual(
    tally.map((t) => [t.riderId, t.declined, t.transferred, t.transferredWithGoods, t.total]),
    [['a', 2, 1, 1, 3], ['b', 0, 1, 0, 1]],
  );
});

test('transfers outrank declines — a stranded order costs more than a pass', () => {
  const tally = summarizeRefusals([
    ...Array.from({ length: 9 }, (_, i) => ev({ id: `d${i}`, riderId: 'passer' })),
    ev({ id: 't1', riderId: 'dropper', kind: 'transferred' }),
    ev({ id: 't2', riderId: 'dropper', kind: 'transferred' }),
  ]);
  assert.deepEqual(tally.map((t) => t.riderId), ['dropper', 'passer']);
});

test('lastAt keeps the most recent event, whatever order they arrive in', () => {
  const [t] = summarizeRefusals([
    ev({ id: '1', riderId: 'a', createdAt: '2026-08-04T02:00:00Z' }),
    ev({ id: '2', riderId: 'a', createdAt: '2026-08-01T02:00:00Z' }),
  ]);
  assert.equal(t!.lastAt, '2026-08-04T02:00:00Z');
});

test('nothing to report summarizes to an empty list', () => {
  assert.deepEqual(summarizeRefusals([]), []);
});
