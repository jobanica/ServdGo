import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onDutyRiders, type ActiveRider } from './adminRiders.ts';

const rider = (over: Partial<ActiveRider> & { id: string; name: string }): ActiveRider => ({
  mobile_number: '0917 000 0000', vehicle: null,
  is_locked: false, is_suspended: false, suspend_reason: null,
  is_online: true, online_since: '2026-08-04T01:00:00Z',
  owed: 0, overdue: 0, activity: 'available', activeOrder: null,
  ...over,
});

test('off-duty riders are left out of the roster', () => {
  const roster = onDutyRiders([
    rider({ id: 'a', name: 'On duty' }),
    rider({ id: 'b', name: 'Off duty', is_online: false, online_since: null, activity: 'offline' }),
  ]);
  assert.deepEqual(roster.map((r) => r.id), ['a']);
});

test('a rider mid-delivery counts as on duty even with the toggle off', () => {
  const roster = onDutyRiders([
    rider({
      id: 'a', name: 'Finishing up', is_online: false, online_since: null,
      activity: 'on_delivery', activeOrder: { id: 'o1', service_type: 'food', status: 'on_the_way' },
    }),
  ]);
  assert.equal(roster.length, 1);
});

test('suspended riders are never on duty', () => {
  const roster = onDutyRiders([
    rider({ id: 'a', name: 'Suspended', is_suspended: true, activity: 'suspended' }),
    // Belt and braces: suspension forces offline, but not if a stale row says otherwise.
    rider({
      id: 'b', name: 'Suspended mid-run', is_suspended: true, activity: 'on_delivery',
      activeOrder: { id: 'o1', service_type: 'food', status: 'accepted' },
    }),
  ]);
  assert.deepEqual(roster, []);
});

test('on-delivery first, then longest on duty, then by name', () => {
  const roster = onDutyRiders([
    rider({ id: 'c', name: 'Recent', online_since: '2026-08-04T05:00:00Z' }),
    rider({ id: 'a', name: 'Longest', online_since: '2026-08-04T00:30:00Z' }),
    rider({
      id: 'd', name: 'Delivering', online_since: '2026-08-04T06:00:00Z',
      activity: 'on_delivery', activeOrder: { id: 'o1', service_type: 'padala', status: 'picked_up' },
    }),
  ]);
  assert.deepEqual(roster.map((r) => r.id), ['d', 'a', 'c']);
});

test('locked riders still show while they are on duty — the operator should see why', () => {
  const roster = onDutyRiders([rider({ id: 'a', name: 'Locked', is_locked: true, activity: 'locked' })]);
  assert.deepEqual(roster.map((r) => r.activity), ['locked']);
});
