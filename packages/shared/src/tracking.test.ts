import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, etaMinutes, lerpLatLng } from './tracking.ts';

test('haversineMeters is ~0 for the same point', () => {
  assert.ok(haversineMeters({ lat: 14.6, lng: 121.0 }, { lat: 14.6, lng: 121.0 }) < 1e-6);
});

test('haversineMeters ~111km per degree of latitude', () => {
  const d = haversineMeters({ lat: 14, lng: 121 }, { lat: 15, lng: 121 });
  assert.ok(Math.abs(d - 111_195) < 500, `got ${d}`);
});

test('etaMinutes: 10km at 20km/h = 30 min', () => {
  assert.equal(Math.round(etaMinutes(10_000, 20)), 30);
});

test('etaMinutes handles zero speed', () => {
  assert.equal(etaMinutes(1000, 0), Infinity);
});

test('lerpLatLng midpoint and clamping', () => {
  const mid = lerpLatLng({ lat: 0, lng: 0 }, { lat: 10, lng: 20 }, 0.5);
  assert.deepEqual(mid, { lat: 5, lng: 10 });
  assert.deepEqual(lerpLatLng({ lat: 0, lng: 0 }, { lat: 10, lng: 10 }, 2), { lat: 10, lng: 10 });
  assert.deepEqual(lerpLatLng({ lat: 0, lng: 0 }, { lat: 10, lng: 10 }, -1), { lat: 0, lng: 0 });
});
