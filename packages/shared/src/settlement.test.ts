import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  owedBalance,
  overdueBalance,
  isLockedOut,
  summarizeRiderBalances,
  type LedgerEntry, owedByKind } from './settlement.ts';

const entries: LedgerEntry[] = [
  { amount: 15, businessDay: '2026-07-14', settled: true },
  { amount: 7.5, businessDay: '2026-07-15', settled: false },
  { amount: 6, businessDay: '2026-07-15', settled: false },
  { amount: 15, businessDay: '2026-07-16', settled: false },
];

test('owedBalance sums all unsettled entries', () => {
  assert.equal(owedBalance(entries), 28.5);
});

test('overdueBalance counts only business days before today', () => {
  // today = 2026-07-16 → only the two 07-15 entries are overdue
  assert.equal(overdueBalance(entries, '2026-07-16'), 13.5);
});

test('rider with previous-day balance is locked out', () => {
  assert.equal(isLockedOut(entries, '2026-07-16'), true);
});

test('rider with only same-day balance is NOT locked out', () => {
  const sameDayOnly: LedgerEntry[] = [
    { amount: 15, businessDay: '2026-07-16', settled: false },
  ];
  assert.equal(isLockedOut(sameDayOnly, '2026-07-16'), false);
});

test('fully settled rider is not locked out', () => {
  const settled: LedgerEntry[] = entries.map((e) => ({ ...e, settled: true }));
  assert.equal(isLockedOut(settled, '2026-07-16'), false);
});

test('summarizeRiderBalances lists only who owes, locked first', () => {
  const groups = [
    { riderId: 'settled', riderName: 'Ana', entries: [
      { amount: 10, businessDay: '2026-07-15', settled: true },
    ] },
    { riderId: 'sameday', riderName: 'Ben', entries: [
      { amount: 8, businessDay: '2026-07-16', settled: false },
    ] },
    { riderId: 'overdue', riderName: 'Cy', entries: [
      { amount: 13.5, businessDay: '2026-07-15', settled: false },
      { amount: 6, businessDay: '2026-07-16', settled: false },
    ] },
  ];
  const out = summarizeRiderBalances(groups, '2026-07-16');
  // 'settled' is dropped (owes nothing); locked 'overdue' sorts before 'sameday'
  assert.deepEqual(out.map((b) => b.riderId), ['overdue', 'sameday']);
  assert.equal(out[0]!.locked, true);
  assert.equal(out[0]!.overdue, 13.5);
  assert.equal(out[0]!.owed, 19.5);
  assert.equal(out[1]!.locked, false);
});

test('owedByKind separates a mark-up charge from commission, ignoring settled rows', () => {
  const split = owedByKind([
    { amount: 11.25, businessDay: '2026-08-10', settled: false, kind: 'commission' },
    { amount: 42, businessDay: '2026-08-10', settled: false, kind: 'markup' },
    { amount: 99, businessDay: '2026-08-09', settled: true, kind: 'markup' },
    // Rows written before mark-ups existed carry no kind: they are commission.
    { amount: 7.5, businessDay: '2026-08-10', settled: false },
  ]);
  assert.deepEqual(split, { commission: 18.75, markup: 42, adjustment: 0 });
});

test('a credit is its own line, and pulls the balance below zero', () => {
  const entries: LedgerEntry[] = [
    { amount: 11.25, businessDay: '2026-08-10', settled: false, kind: 'commission' },
    { amount: -69.63, businessDay: '2026-08-10', settled: false, kind: 'adjustment' },
  ];
  assert.deepEqual(owedByKind(entries), { commission: 11.25, markup: 0, adjustment: -69.63 });
  // Negative owed means the operator owes the rider.
  assert.equal(owedBalance(entries), -58.38);
});

test('a rider the operator owes still appears in the admin list', () => {
  const [only] = summarizeRiderBalances(
    [{ riderId: 'r1', riderName: 'Neil', entries: [
      { amount: -69.63, businessDay: '2026-08-17', settled: false, kind: 'adjustment' },
    ] }],
    '2026-08-18',
  );
  assert.equal(only?.owed, -69.63);
  // A credit is not a debt: it must never lock the rider out.
  assert.equal(only?.locked, false);
});
