import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortRequestQueue, queueHead, isQueueHead, queuePosition, type QueuedRequest } from './queue.ts';

const pool: QueuedRequest[] = [
  { id: 'new-late', createdAt: '2026-08-04T12:00:00Z', isTransfer: false },
  { id: 'new-early', createdAt: '2026-08-04T09:00:00Z', isTransfer: false },
  { id: 'transfer-late', createdAt: '2026-08-04T11:00:00Z', isTransfer: true },
  { id: 'transfer-early', createdAt: '2026-08-04T10:00:00Z', isTransfer: true },
];

test('transfers come first, oldest first within each group', () => {
  assert.deepEqual(
    sortRequestQueue(pool).map((o) => o.id),
    ['transfer-early', 'transfer-late', 'new-early', 'new-late'],
  );
});

test('sortRequestQueue does not mutate its input', () => {
  const before = pool.map((o) => o.id);
  sortRequestQueue(pool);
  assert.deepEqual(pool.map((o) => o.id), before);
});

test('ties on timestamp break by id, so every rider sees the same head', () => {
  const tied: QueuedRequest[] = [
    { id: 'b', createdAt: '2026-08-04T09:00:00Z', isTransfer: false },
    { id: 'a', createdAt: '2026-08-04T09:00:00Z', isTransfer: false },
  ];
  assert.equal(queueHead(tied)?.id, 'a');
  assert.equal(queueHead([...tied].reverse())?.id, 'a');
});

test('only the head of the queue may be accepted', () => {
  assert.ok(isQueueHead(pool, 'transfer-early'));
  assert.ok(!isQueueHead(pool, 'new-early'));
});

test('queueHead is null for an empty pool, and nothing is the head', () => {
  assert.equal(queueHead([]), null);
  assert.ok(!isQueueHead([], 'anything'));
});

test('queuePosition numbers the wait from 1, and 0 when not pooled', () => {
  assert.equal(queuePosition(pool, 'transfer-early'), 1);
  assert.equal(queuePosition(pool, 'new-late'), 4);
  assert.equal(queuePosition(pool, 'not-in-pool'), 0);
});
