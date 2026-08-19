import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionAtLeast } from './platform.ts';

// This decides whether a rider's phone is allowed to open the app at all, so
// the cases that matter are the awkward ones: unequal lengths, double digits,
// and whatever a broken build reports as its version.

test('equal versions pass', () => {
  assert.equal(versionAtLeast('1.2.3', '1.2.3'), true);
});

test('newer passes, older does not', () => {
  assert.equal(versionAtLeast('1.3.0', '1.2.9'), true);
  assert.equal(versionAtLeast('1.2.9', '1.3.0'), false);
});

test('parts are numbers, not text', () => {
  assert.equal(versionAtLeast('1.10.0', '1.9.0'), true);
  assert.equal(versionAtLeast('1.9.0', '1.10.0'), false);
});

test('missing parts count as zero', () => {
  assert.equal(versionAtLeast('2', '2.0.0'), true);
  assert.equal(versionAtLeast('2.0', '2.0.1'), false);
  assert.equal(versionAtLeast('2.0.1', '2.0'), true);
});

test('an unparseable version is treated as the oldest possible', () => {
  assert.equal(versionAtLeast('', '1.0.0'), false);
  assert.equal(versionAtLeast('dev', '1.0.0'), false);
  // …but it still runs when nothing is required.
  assert.equal(versionAtLeast('dev', '0.0.0'), true);
});
