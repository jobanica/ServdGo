import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition } from './types.ts';

test('food advances one step at a time', () => {
  assert.equal(canTransition('food', 'pending', 'accepted'), true);
  assert.equal(canTransition('food', 'accepted', 'preparing'), true);
  assert.equal(canTransition('food', 'pending', 'delivered'), false);
});

test('padala skips the preparing step', () => {
  assert.equal(canTransition('padala', 'accepted', 'picked_up'), true);
  assert.equal(canTransition('padala', 'accepted', 'preparing'), false);
});

test('any non-delivered order may be cancelled', () => {
  assert.equal(canTransition('food', 'accepted', 'cancelled'), true);
  assert.equal(canTransition('food', 'delivered', 'cancelled'), false);
});
