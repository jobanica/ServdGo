import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeStoreOrderSms, smsSegments, normalizePhMobile } from './sms.ts';

test('composes a store order SMS with items', () => {
  const body = composeStoreOrderSms({
    storeName: 'Lutong Bahay',
    items: [{ name: 'Chicken Adobo', qty: 2 }, { name: 'Extra Rice', qty: 1 }],
  });
  assert.match(body, /ServdGo order for Lutong Bahay:/);
  assert.match(body, /2x Chicken Adobo/);
  assert.match(body, /1x Extra Rice/);
  assert.match(body, /Please prepare for pickup\./);
});

test('includes notes and customer contact when present', () => {
  const body = composeStoreOrderSms({
    storeName: 'Barrio Brew',
    items: [{ name: 'Milk Tea', qty: 1 }],
    customerContact: '0917 123 4567',
    notes: 'less sugar',
  });
  assert.match(body, /Note: less sugar/);
  assert.match(body, /Customer: 0917 123 4567/);
});

test('omits empty notes', () => {
  const body = composeStoreOrderSms({
    storeName: 'X', items: [{ name: 'A', qty: 1 }], notes: '   ',
  });
  assert.ok(!body.includes('Note:'));
});

test('smsSegments counts 160-char segments', () => {
  assert.equal(smsSegments('short'), 1);
  assert.equal(smsSegments('a'.repeat(160)), 1);
  assert.equal(smsSegments('a'.repeat(161)), 2);
});

test('normalizePhMobile produces 639XXXXXXXXX', () => {
  assert.equal(normalizePhMobile('0917 123 4567'), '639171234567');
  assert.equal(normalizePhMobile('+639171234567'), '639171234567');
  assert.equal(normalizePhMobile('639171234567'), '639171234567');
  assert.equal(normalizePhMobile('9171234567'), '639171234567');
});
