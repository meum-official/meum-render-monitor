import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceRole } from '../resource-contracts.mjs';

const main = 'https://meum.me';
const api = 'https://backend.meum.me';
const classify = (path, patch = {}) => resourceRole({ url: api + path, method: 'GET', resourceType: 'fetch', targetUrl: main + '/home', ...patch });
const expect = (actual, role, contract) => assert.deepEqual(actual, { role, contract, sourceEvidence: contract });

test('only this application document/script/stylesheet are essential; telemetry precedes script classification', () => {
  for (const [type, contract] of [['document', 'document'], ['script', 'application-script'], ['stylesheet', 'stylesheet']]) {
    expect(resourceRole({ url: main + '/assets/app.js', resourceType: type, targetUrl: main + '/home' }), 'essential', contract);
    expect(resourceRole({ url: 'https://external.example/app.js', resourceType: type, targetUrl: main + '/home' }), 'unknown', 'unclassified');
  }
  expect(resourceRole({ url: 'https://www.googletagmanager.com/gtag/js?id=private-value', resourceType: 'script', targetUrl: main + '/home' }), 'optional', 'telemetry');
  expect(resourceRole({ url: main + '/font.woff', resourceType: 'font', targetUrl: main + '/home' }), 'unknown', 'unclassified');
});

test('normal viewer prerequisites use exact methods/paths and do not grant permission to mutate', () => {
  const targetUrl = main + '/meum-lite-viewer?r=4Q8xmY';
  for (const [path, method, role, contract] of [
    ['/api/rooms/4348/viewer-entry', 'GET', 'essential', 'viewer-entry-preflight'],
    ['/api/rooms/4348/password/status', 'GET', 'essential', 'viewer-password-bootstrap'],
    ['/api/rooms/roomById', 'POST', 'essential', 'viewer-room-bootstrap'],
    ['/api/rooms/getDataJson?room_id=4348', 'GET', 'essential', 'viewer-scene-data'],
    ['/item/userItem-list?room_id=4348', 'GET', 'essential', 'viewer-items'],
    ['/api/rooms/comment-settings/4348', 'GET', 'optional', 'viewer-comments'],
    ['/user/room/detail/?room_id=4348', 'GET', 'optional', 'viewer-seo'],
  ]) expect(classify(path, { targetUrl, method }), role, contract);
  expect(classify('/api/rooms/roomById', { targetUrl, method: 'GET' }), 'unknown', 'unclassified');
  expect(classify('/api/rooms/getDataJson', { targetUrl, method: 'POST' }), 'unknown', 'unclassified');
  expect(classify('/api/rooms/getDataJson-extra', { targetUrl }), 'unknown', 'unclassified');
  expect(classify('/api/rooms/getDataJson', { targetUrl: main + '/home' }), 'unknown', 'unclassified');
});

test('best-effort analytics are optional only at exact observed collectors and never grant write permission', () => {
  expect(resourceRole({ url: 'https://www.google.co.kr/ads/ga-audiences?x=1', targetUrl: main + '/login', method: 'GET', resourceType: 'image' }), 'optional', 'telemetry');
  for (const patch of [{ method: 'POST' }, { resourceType: 'fetch' }, { url: 'https://www.google.co.kr/ads/other' }, { url: 'https://www.google.co.kr.evil.example/ads/ga-audiences' }]) expect(resourceRole({ url: 'https://www.google.co.kr/ads/ga-audiences', targetUrl: main + '/login', method: 'GET', resourceType: 'image', ...patch }), 'unknown', 'unclassified');
  for (const origin of ['https://backend.meum.me', 'https://www.google.com', 'https://analytics.google.com', 'https://stats.g.doubleclick.net']) {
    const path = origin === api ? '/analytics/ingest' : '/g/collect';
    for (const type of ['fetch', 'xhr', 'other', 'ping']) expect(resourceRole({ url: origin + path + '?token=SECRET', targetUrl: main + '/home', method: 'POST', resourceType: type, status: 502 }), 'optional', 'telemetry');
    for (const patch of [{ method: 'GET' }, { method: 'DELETE' }, { resourceType: 'script' }, { url: origin + path + '-extra' }, { url: origin + '/oauth' }]) expect(resourceRole({ url: origin + path, targetUrl: main + '/home', method: 'POST', resourceType: 'fetch', ...patch }), 'unknown', 'unclassified');
  }
  expect(resourceRole({ url: 'https://www.google.com.evil.example/g/collect', targetUrl: main + '/home', method: 'POST', resourceType: 'fetch' }), 'unknown', 'unclassified');
  expect(resourceRole({ url: 'http://127.0.0.1:9123/analytics/ingest', targetUrl: 'http://127.0.0.1:9123/home', method: 'POST', resourceType: 'fetch' }), 'optional', 'telemetry');
  expect(resourceRole({ url: 'http://127.0.0.1:9999/analytics/ingest', targetUrl: 'http://127.0.0.1:9123/home', method: 'POST', resourceType: 'fetch' }), 'unknown', 'unclassified');
});

test('same detail endpoint is required on preview/invitation, optional on viewer and unknown elsewhere', () => {
  for (const path of ['/exhibition/preview/4348', '/exhibition/4348', '/exhibition/invitation/4Q8xmY']) {
    expect(classify('/user/room/detail?room_id=4348', { targetUrl: main + path }), 'essential', 'preview-detail');
    expect(classify('/api/users/simple_profile?userid=1', { targetUrl: main + path }), 'optional', 'optional-owner-profile');
  }
  expect(classify('/user/room/detail', { targetUrl: main + '/home' }), 'unknown', 'unclassified');
  expect(classify('/exhibition/invitation/4Q8xmY/introduction', { targetUrl: main + '/exhibition/invitation/4Q8xmY' }), 'essential', 'invitation-intro');
  expect(classify('/exhibition/invitation/4Q8xmY/introduction', { targetUrl: main + '/home' }), 'unknown', 'unclassified');
});

test('archive plaintext viewer has its own required data source, not ordinary scene prerequisites', () => {
  const targetUrl = 'https://archive.meum.me/archive/viewer/35';
  expect(classify('/api/archive/rooms/35', { targetUrl }), 'essential', 'archive-room');
  expect(classify('/api/rooms/getDataJson', { targetUrl }), 'unknown', 'unclassified');
  expect(classify('/api/archive/rooms/35', { targetUrl: main + '/home' }), 'unknown', 'unclassified');
});

test('webtoon catalog is runtime-conditional and exact optional likes fallback statuses are warnings only', () => {
  for (const path of ['/webtoon', '/webtoon/1']) {
    const targetUrl = main + path;
    expect(classify('/api/webtoon/episodes', { targetUrl, status: 503 }), 'essential', 'webtoon-catalog');
    for (const status of [null, 200, 401, 419, 403, 404, 501, 503]) expect(classify('/api/webtoon/episodes/1/likes', { targetUrl, status }), 'optional', 'webtoon-likes');
    for (const status of [400, 409, 429, 500, 502, 504]) expect(classify('/api/webtoon/episodes/1/likes', { targetUrl, status }), 'unknown', 'webtoon-likes');
    expect(classify('/api/webtoon/episodes/1/likes', { targetUrl, method: 'POST' }), 'unknown', 'unclassified');
  }
  expect(classify('/api/webtoon/episodes'), 'unknown', 'unclassified');
  expect(classify('/api/webtoon/episodes/1/likes'), 'unknown', 'unclassified');
});

test('optional shared auth/header/navigation calls do not make unrelated endpoints optional', () => {
  expect(classify('/boards/list/check-new', { status: 404 }), 'optional', 'optional-navigation-badge');
  expect(classify('/api/users/my_plan?userid=123', { status: 401 }), 'optional', 'optional-plan');
  expect(classify('/nodeApi/user', { method: 'POST' }), 'optional', 'optional-session');
  expect(classify('/nodeApi/user', { method: 'GET' }), 'unknown', 'unclassified');
  expect(classify('/boards/123', { status: 404 }), 'unknown', 'unclassified');
  expect(classify('/user/login', { method: 'POST', targetUrl: main + '/login/info' }), 'unknown', 'unclassified');
  expect(classify('/api/users/my_plan-extra', { status: 401 }), 'unknown', 'unclassified');
});

test('pricing configuration is required only on pricing targets, not every backend request', () => {
  for (const path of ['/plan', '/en/pricing']) expect(classify('/api/billing/plan/catalog?country=US', { targetUrl: main + path, status: 500 }), 'essential', 'pricing-catalog');
  expect(classify('/api/billing/plan/catalog', { status: 500 }), 'unknown', 'unclassified');
  expect(classify('/api/billing/plan/payments/status', { targetUrl: main + '/plan', status: 401 }), 'unknown', 'unclassified');
  expect(classify('/unknown-endpoint', { status: 500 }), 'unknown', 'unclassified');
});

test('untrusted origin/method/resource types and malformed locations cannot inherit application roles or expose private values', () => {
  for (const patch of [
    { url: 'https://backend.meum.me.evil.example/api/rooms/getDataJson' },
    { resourceType: 'image' }, { method: 'DELETE' },
    { url: 'https://private:secret@backend.meum.me/api/rooms/getDataJson' },
    { targetUrl: 'https://external.example/meum-lite-viewer' },
    { url: 'not-a-url' }, { targetUrl: 'not-a-url' },
  ]) expect(classify('/api/rooms/getDataJson', { targetUrl: main + '/meum-lite-viewer?r=private-hash', ...patch }), 'unknown', 'unclassified');
  const observed = classify('/api/rooms/getDataJson?room_id=4348&private=secret', { targetUrl: main + '/meum-lite-viewer?r=private-hash' });
  assert.doesNotMatch(JSON.stringify(observed), /4348|secret|private-hash|https?:|room_id/);
  expect(resourceRole({ url: 'http://127.0.0.1:9123/api/rooms/getDataJson', targetUrl: 'http://127.0.0.1:9123/meum-lite-viewer', resourceType: 'fetch' }), 'essential', 'viewer-scene-data');
  expect(resourceRole({ url: 'http://127.0.0.1:9999/api/rooms/getDataJson', targetUrl: 'http://127.0.0.1:9123/meum-lite-viewer', resourceType: 'fetch' }), 'unknown', 'unclassified');
});
