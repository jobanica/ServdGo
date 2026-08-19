import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCsvLine, parseMenuCsv, groupByStore } from './csv.ts';

test('splitCsvLine handles quotes, commas, escaped quotes', () => {
  assert.deepEqual(splitCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitCsvLine('"Lutong, Bahay",Filipino,95'), ['Lutong, Bahay', 'Filipino', '95']);
  assert.deepEqual(splitCsvLine('"say ""hi""",x'), ['say "hi"', 'x']);
});

const CSV = `store,contact,section,item,price
Lutong Bahay,0918 555 0100,Mains,Chicken Adobo,95
Lutong Bahay,,Mains,Pork Sinigang,120
Barrio Brew,,Drinks,Wintermelon Milk Tea,90`;

test('parseMenuCsv reads valid rows', () => {
  const { rows, errors } = parseMenuCsv(CSV);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { store: 'Lutong Bahay', contact: '0918 555 0100', section: 'Mains', item: 'Chicken Adobo', price: 95 });
});

test('parseMenuCsv strips currency from price', () => {
  const { rows } = parseMenuCsv('store,item,price\nA,X,₱120.50');
  assert.equal(rows[0]!.price, 120.5);
});

test('parseMenuCsv flags missing required columns', () => {
  const { errors } = parseMenuCsv('store,item\nA,X');
  assert.match(errors[0]!.message, /Missing column\(s\): price/);
});

test('parseMenuCsv reports per-row errors and keeps good rows', () => {
  const { rows, errors } = parseMenuCsv('store,item,price\nA,X,95\n,Y,10\nB,Z,notaprice');
  assert.equal(rows.length, 1);
  assert.equal(errors.length, 2);
  assert.equal(errors[0]!.line, 3); // missing store
  assert.equal(errors[1]!.line, 4); // bad price
});

test('groupByStore groups items and carries contact', () => {
  const { rows } = parseMenuCsv(CSV);
  const g = groupByStore(rows);
  assert.equal(g.size, 2);
  assert.equal(g.get('Lutong Bahay')!.items.length, 2);
  assert.equal(g.get('Lutong Bahay')!.contact, '0918 555 0100');
});
