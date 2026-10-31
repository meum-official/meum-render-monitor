import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReadAllowed, reviewedPublicRenderRead } from '../render-mode.mjs';
import { resourceRole } from '../resource-contracts.mjs';

const api = 'https://backend.meum.me';
const request = (path, patch = {}) => ({ url: () => api + path, method: () => 'GET', headers: () => ({}), resourceType: () => 'fetch', isNavigationRequest: () => false, ...patch });
const cases = [
  ['https://archive.meum.me/', '/api/archive/owners?activeOnly=0&limit=50&offset=0'],
  ['https://archive.meum.me/?page=2', '/api/archive/owners?limit=50&offset=50&activeOnly=0'],
  ['https://archive.meum.me/archive/synthetic?i=17', '/api/archive/owners/17'],
  ['https://archive.meum.me/archive/synthetic?i=17', '/api/archive/rooms?ownerId=17&limit=50&offset=0'],
  ['https://meum.me/creator/ws_Synthetic', '/api/workspaces/creator/ws_Synthetic'],
];

test('audited anonymous reads are limited to the exact page caller and query', () => {
  for (const [target, path] of cases) {
    assert.equal(renderReadAllowed(request(path), [], target), true, path);
    for (const wrongTarget of [undefined, 'https://external.invalid/', 'https://meum.me/home', target + '#private']) assert.equal(renderReadAllowed(request(path), [], wrongTarget), false);
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) assert.equal(renderReadAllowed(request(path, { method: () => method }), [], target), false);
    for (const headers of [{ Authorization: 'synthetic' }, { Cookie: 'synthetic' }, { 'proxy-authorization': 'synthetic' }]) assert.equal(renderReadAllowed(request(path, { headers: () => headers }), [], target), false);
    for (const type of ['document', 'script', 'image']) assert.equal(renderReadAllowed(request(path, { resourceType: () => type }), [], target), false);
    for (const origin of ['http://backend.meum.me', 'https://backend.meum.me.evil.invalid']) assert.equal(reviewedPublicRenderRead(request(path, { url: () => origin + path }), target), false);
  }
});

test('archive pagination, identity and public creator permissions cannot expand to unrelated reads', () => {
  const invalid = [
    [cases[0][0], '/api/archive/owners?activeOnly=1&limit=50&offset=0'],
    [cases[0][0], '/api/archive/owners?activeOnly=0&limit=100&offset=0'],
    [cases[0][0], '/api/archive/owners?activeOnly=0&limit=50&offset=50'],
    [cases[1][0], cases[0][1]],
    [cases[0][0], cases[0][1] + '&token=private'],
    [cases[0][0], cases[0][1] + '&limit=50'],
    [cases[2][0], '/api/archive/owners/18'],
    [cases[2][0], '/api/archive/rooms?ownerId=18&limit=50&offset=0'],
    [cases[2][0], '/api/archive/rooms?ownerId=17&limit=50&offset=50'],
    [cases[2][0] + '&page=2', cases[2][1]],
    [cases[4][0], '/api/workspaces/creator/ws_Other'],
    [cases[4][0], cases[4][1] + '?token=private'],
    [cases[4][0], '/api/workspaces/my'],
    [cases[4][0], '/api/workspaces/17/members'],
  ];
  for (const [target, path] of invalid) assert.equal(renderReadAllowed(request(path), [], target), false, path);
  for (const path of ['/api/rooms/17/password/status', '/api/rooms/getDataJson?room_id=17', '/api/rooms/17/roses', '/api/rooms/roomById']) for (const method of ['GET', 'POST']) assert.equal(renderReadAllowed(request(path, { method: () => method }), [], cases[4][0]), false);
  assert.equal(renderReadAllowed(request('/embed/synthetic', { url: () => 'https://www.youtube.com/embed/synthetic', resourceType: () => 'document', isNavigationRequest: () => true }), ['https://meum.me'], 'https://meum.me/school/teacher-guide'), false);
});

test('new public caller dependencies retain failures for real HTTP errors', () => {
  for (const [target, path] of cases) assert.equal(resourceRole({ url: api + path, method: 'GET', resourceType: 'fetch', targetUrl: target, status: 500 }).role, 'essential');
});
