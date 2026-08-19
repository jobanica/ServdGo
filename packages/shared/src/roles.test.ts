import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, sectionsFor, isStaffRole, STAFF_ROLES } from './roles.ts';

test('admin can open every section', () => {
  assert.equal(can('admin', 'settings'), true);
  assert.equal(can('admin', 'staff'), true);
  assert.equal(can('admin', 'orders'), true);
});

test('settings and staff are admin-only', () => {
  for (const r of ['manager', 'dispatcher', 'support'] as const) {
    assert.equal(can(r, 'settings'), false, `${r} settings`);
    assert.equal(can(r, 'staff'), false, `${r} staff`);
  }
});

test('manager runs operations but not settings', () => {
  assert.equal(can('manager', 'settlements'), true);
  assert.equal(can('manager', 'broadcast'), true);
  assert.equal(can('manager', 'settings'), false);
});

test('dispatcher is focused on orders and riders', () => {
  assert.equal(can('dispatcher', 'orders'), true);
  assert.equal(can('dispatcher', 'ridersActive'), true);
  assert.equal(can('dispatcher', 'broadcast'), false);
  assert.equal(can('dispatcher', 'settlements'), false);
});

test('support sees orders, history, broadcast only', () => {
  assert.deepEqual(sectionsFor('support'), ['dashboard', 'orders', 'history', 'broadcast']);
});

test('sectionsFor always begins with dashboard', () => {
  for (const r of STAFF_ROLES) assert.equal(sectionsFor(r)[0], 'dashboard');
});

test('isStaffRole guards non-staff roles', () => {
  assert.equal(isStaffRole('admin'), true);
  assert.equal(isStaffRole('customer'), false);
  assert.equal(isStaffRole(null), false);
});
