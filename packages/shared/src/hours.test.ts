import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHm, isOpenNow, formatHm, scheduleLabel, daysLabel, manilaWeekday } from './hours.ts';

test('parseHm parses HH:MM and HH:MM:SS', () => {
  assert.equal(parseHm('09:00'), 540);
  assert.equal(parseHm('21:30:00'), 1290);
  assert.equal(parseHm(null), null);
  assert.equal(parseHm('bad'), null);
  assert.equal(parseHm('25:00'), null);
});

test('no schedule means always open', () => {
  assert.equal(isOpenNow(null, null), true);
  assert.equal(isOpenNow('09:00', null), true);
});

test('same-day window', () => {
  // 2020-01-01T05:00:00Z = 13:00 Manila (open)
  assert.equal(isOpenNow('09:00', '21:00', null, new Date('2020-01-01T05:00:00Z')), true);
  // 2020-01-01T00:00:00Z = 08:00 Manila (before open)
  assert.equal(isOpenNow('09:00', '21:00', null, new Date('2020-01-01T00:00:00Z')), false);
  // 2020-01-01T14:00:00Z = 22:00 Manila (after close)
  assert.equal(isOpenNow('09:00', '21:00', null, new Date('2020-01-01T14:00:00Z')), false);
});

test('overnight window crosses midnight', () => {
  assert.equal(isOpenNow('18:00', '02:00', null, new Date('2020-01-01T17:00:00Z')), true);  // 01:00 Manila
  assert.equal(isOpenNow('18:00', '02:00', null, new Date('2020-01-01T12:00:00Z')), true);  // 20:00 Manila
  assert.equal(isOpenNow('18:00', '02:00', null, new Date('2020-01-01T06:00:00Z')), false); // 14:00 Manila
});

test('closed on specific weekdays', () => {
  // 2020-01-05 is a Sunday. 12:00Z = 20:00 Manila Sunday.
  const sundayNoon = new Date('2020-01-05T04:00:00Z'); // 12:00 Manila Sunday
  assert.equal(manilaWeekday(sundayNoon), 0);
  // Open Mon–Sat (no Sunday) → closed on Sunday even within hours.
  assert.equal(isOpenNow('09:00', '21:00', [1, 2, 3, 4, 5, 6], sundayNoon), false);
  // Open every day → open.
  assert.equal(isOpenNow('09:00', '21:00', [0, 1, 2, 3, 4, 5, 6], sundayNoon), true);
  // A Monday within hours, open Mon–Sat → open.
  const mondayNoon = new Date('2020-01-06T04:00:00Z'); // 12:00 Manila Monday
  assert.equal(manilaWeekday(mondayNoon), 1);
  assert.equal(isOpenNow('09:00', '21:00', [1, 2, 3, 4, 5, 6], mondayNoon), true);
});

test('formatHm, daysLabel and scheduleLabel', () => {
  assert.equal(formatHm('09:00'), '9:00 AM');
  assert.equal(formatHm('21:05'), '9:05 PM');
  assert.equal(formatHm('00:00'), '12:00 AM');
  assert.equal(daysLabel(null), 'Every day');
  assert.equal(daysLabel([0, 1, 2, 3, 4, 5, 6]), 'Every day');
  assert.equal(daysLabel([1, 2, 3, 4, 5, 6]), 'Closed Sun');
  assert.equal(daysLabel([1, 2, 4, 5, 6]), 'Closed Sun, Wed');
  assert.equal(scheduleLabel('09:00', '21:00', null), '9:00 AM – 9:00 PM');
  assert.equal(scheduleLabel('09:00', '21:00', [1, 2, 3, 4, 5, 6]), 'Closed Sun · 9:00 AM – 9:00 PM');
  assert.equal(scheduleLabel(null, null, null), 'Open 24 hours');
});
