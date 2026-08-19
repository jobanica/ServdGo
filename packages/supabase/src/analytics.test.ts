import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyticsRange } from './analytics.ts';

test('a day count resolves to that many inclusive days ending today', () => {
  assert.deepEqual(analyticsRange(7, '2026-08-04'), { from: '2026-07-29', to: '2026-08-04' });
  assert.deepEqual(analyticsRange(1, '2026-08-04'), { from: '2026-08-04', to: '2026-08-04' });
});

test('an explicit span is kept, and a backwards one is read as the span between', () => {
  assert.deepEqual(
    analyticsRange({ from: '2026-07-01', to: '2026-07-15' }, '2026-08-04'),
    { from: '2026-07-01', to: '2026-07-15' },
  );
  assert.deepEqual(
    analyticsRange({ from: '2026-07-15', to: '2026-07-01' }, '2026-08-04'),
    { from: '2026-07-01', to: '2026-07-15' },
  );
});

test('a nonsensical day count still yields a single valid day', () => {
  assert.deepEqual(analyticsRange(0, '2026-08-04'), { from: '2026-08-04', to: '2026-08-04' });
  assert.deepEqual(analyticsRange(-5, '2026-08-04'), { from: '2026-08-04', to: '2026-08-04' });
});
