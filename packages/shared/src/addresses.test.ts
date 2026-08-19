import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesSavedAddress, findSavedAddress, isNewAddress,
  nextAddressLabel, availableLabels, addressTitle, sortAddresses,
  type SavedAddress,
} from './addresses.ts';

const home: SavedAddress = {
  id: 'a', label: 'Home', address: '12 Sampaguita St., Brgy. San Jose',
  lat: 14.186, lng: 121.256, is_default: true,
};
const office: SavedAddress = {
  id: 'b', label: 'Office', address: '3F Ayala Tower, Makati',
  lat: 14.55, lng: 121.02, is_default: false,
};

test('a pin a few metres off is the same doorstep', () => {
  // ~40 m north of the saved pin: the same house, re-pinned by a shaky thumb.
  assert.ok(matchesSavedAddress(home, { pin: { lat: 14.18636, lng: 121.256 } }));
});

test('a pin down the road is somewhere new', () => {
  assert.ok(!matchesSavedAddress(home, { pin: { lat: 14.20, lng: 121.256 } }));
});

test('the written address matches even when there is no pin', () => {
  assert.ok(matchesSavedAddress(home, { address: '12 sampaguita st  brgy. san jose' }));
  assert.ok(!matchesSavedAddress(home, { address: '99 Ilang-Ilang St.' }));
});

test('an empty written address never matches on text alone', () => {
  assert.ok(!matchesSavedAddress(home, { address: '   ' }));
});

test('findSavedAddress picks the one it came from', () => {
  assert.equal(findSavedAddress([home, office], { pin: { lat: 14.55, lng: 121.0201 } })?.id, 'b');
  assert.equal(findSavedAddress([home, office], { pin: { lat: 15, lng: 122 } }), null);
});

test('only a genuinely new drop-off is worth offering to save', () => {
  assert.ok(isNewAddress([home], { pin: { lat: 14.55, lng: 121.02 } }));
  assert.ok(!isNewAddress([home], { pin: { lat: 14.186, lng: 121.256 } }));
  // Nothing to save is not a new address.
  assert.ok(!isNewAddress([home], {}));
  assert.ok(!isNewAddress([home], { address: '' }));
});

test('unlabelled addresses are numbered around the ones already taken', () => {
  assert.equal(nextAddressLabel([]), 'Address 1');
  assert.equal(nextAddressLabel([home]), 'Address 2');
  assert.equal(nextAddressLabel([home, { label: 'Address 2' } as SavedAddress]), 'Address 3');
});

test('a label already in use is not offered again', () => {
  assert.deepEqual(availableLabels([home]), ['Office']);
  assert.deepEqual(availableLabels([home, office]), []);
  assert.deepEqual(availableLabels([]), ['Home', 'Office']);
});

test('an unlabelled address shows its first line', () => {
  assert.equal(addressTitle({ ...home, label: null }), '12 Sampaguita St.');
  assert.equal(addressTitle({ ...home, label: null, address: '' }), 'Saved address');
  assert.equal(addressTitle(home), 'Home');
});

test('the default comes first', () => {
  assert.deepEqual(sortAddresses([office, home]).map((a) => a.id), ['a', 'b']);
});
