import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  geolocationHelp, isCoarseFix, coarseFixHelp,
  GEO_PERMISSION_DENIED, GEO_POSITION_UNAVAILABLE, GEO_TIMEOUT,
} from './geo.ts';

const web = { ios: false, standalone: false, inAppBrowser: null };
const iphone = { ios: true, standalone: false, inAppBrowser: null };
const homeScreen = { ios: true, standalone: true, inAppBrowser: null };

test('a denied iPhone request names the Safari settings path', () => {
  const msg = geolocationHelp(GEO_PERMISSION_DENIED, iphone);
  assert.match(msg, /Safari Websites/);
  assert.match(msg, /While Using the App/);
});

test('a home-screen install points at the app entry, not Safari Websites', () => {
  const msg = geolocationHelp(GEO_PERMISSION_DENIED, homeScreen);
  assert.match(msg, /Easy Buy Delivery in the list/);
  assert.doesNotMatch(msg, /Safari Websites/);
});

test('an in-app browser is called out before anything else', () => {
  const msg = geolocationHelp(GEO_PERMISSION_DENIED, { ...iphone, inAppBrowser: 'Messenger' });
  assert.match(msg, /^Messenger blocks location/);
  assert.match(msg, /Safari/); // iOS is sent to Safari, not Chrome
});

test('every failure still offers the thing that always works', () => {
  for (const code of [GEO_PERMISSION_DENIED, GEO_POSITION_UNAVAILABLE, GEO_TIMEOUT, 99]) {
    for (const ctx of [web, iphone, homeScreen]) {
      assert.match(geolocationHelp(code, ctx), /tap the map/);
    }
  }
});

test('a timeout is explained as slowness, not as a refusal', () => {
  assert.match(geolocationHelp(GEO_TIMEOUT, iphone), /took too long/);
});

test('a fix wider than a kilometre is too vague to deliver to', () => {
  assert.equal(isCoarseFix(20), false);
  assert.equal(isCoarseFix(999), false);
  assert.equal(isCoarseFix(1500), true);
  assert.equal(isCoarseFix(null), false);
  assert.equal(isCoarseFix(undefined), false);
  assert.match(coarseFixHelp({ ios: true }), /Precise Location/);
});
