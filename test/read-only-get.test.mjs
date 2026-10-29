import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { knownMutatingRead, readPolicyDecision, READ_POLICY_CODES } from '../read-only-policy.mjs';
import { launchBrowser, probe } from '../probe.mjs';

test('known state-changing GET/HEAD paths are denied without blocking their read-only alternatives', () => {
  for (const pathname of ['/api/oneday/public-count', '/api/oneday/public-id/view', '/api/oneday/public-id/guestbooks', '/api/oneday/public-id/owner', '/api/oneday/public-id/report', '/api/oneday/mine', '/page/example', '/meum/name/123', '/api/rooms/comment-settings/123', '/api/rooms/getDataJson?room_id=123', '/api/rooms/123/invitation-settings', '/api/rooms/123/roses', '/api/rooms/123/password/status', '/api/rooms/123/password/socket-ticket', '/boards/42', '/boards/+1', '/boards/1.5', '/boards/%2B1', '/API/ONEDAY/PUBLIC-COUNT/']) assert.equal(knownMutatingRead('https://backend.meum.me' + pathname), true, pathname);
  for (const pathname of ['/api/rooms/123/viewer-entry', '/api/rooms/123/public-invitation-settings', '/api/archive/rooms/35', '/room/list?is_expired=false', '/exhibition/invitation/PublicHash/introduction', '/room/123']) assert.equal(knownMutatingRead('https://backend.meum.me' + pathname), false, pathname);
});

test('policy diagnostics use fixed reason enums and never echo paths, identifiers, credentials or query values', () => {
  const examples = [
    ['https://backend.meum.me/api/rooms/123/password/status?token=private-value', 'password-attempt-state', 'room-password-status'],
    ['https://backend.meum.me/api/rooms/getDataJson?room_id=123', 'scene-dto-migration', 'room-scene-data'],
    ['https://backend.meum.me/api/rooms/123/password/socket-ticket', 'socket-capability', 'room-password-socket-ticket'],
    ['https://backend.meum.me/api/rooms/123/roses', 'rose-claim-and-capability', 'room-roses'],
    ['https://backend.meum.me/api/rooms/123/viewer-entry', 'not-known-mutating', 'other-read'],
  ];
  for (const [url, code, endpoint] of examples) {
    const decision = readPolicyDecision(url);
    assert.deepEqual(decision, { blocked: code !== 'not-known-mutating', code, endpoint });
    assert.equal(knownMutatingRead(url), decision.blocked);
    assert.ok(READ_POLICY_CODES.includes(decision.code));
    assert.doesNotMatch(JSON.stringify(decision), /123|private-value|room_id|https?:/);
  }
  assert.equal(READ_POLICY_CODES.includes('rose-default-create'), false);
  for (const raw of ['not-a-url', 'file:///api/rooms/123', 'https://secret:password@backend.meum.me/room/123', 'https://backend.meum.me/%GG']) {
    assert.deepEqual(readPolicyDecision(raw), { blocked: true, code: 'invalid-url', endpoint: 'invalid-url' });
  }
});

test('a page cannot execute a counter-repair GET or HEAD; lightweight inspection still completes', { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 30000 }, async () => {
  let mutationCalls = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/oneday/public-count') { mutationCalls++; res.setHeader('Content-Type', 'application/json'); res.end('{"count":4}'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body style="background:linear-gradient(45deg,#bce,#cfb)"><main style="padding:40px"><h1>Read-only fixture</h1><p>This private synthetic page must never execute a counter repair.</p></main><script>fetch("/api/oneday/public-count").catch(()=>{});fetch("/api/oneday/public-count",{method:"HEAD"}).catch(()=>{});</script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await launchBrowser();
    const result = await probe(browser, { id: 'a'.repeat(20), url: origin + '/', viewport: { name: 'desktop', width: 900, height: 600 }, rule: { selectors: ['main h1'] } }, { origins: [origin], navigationTimeoutMs: 3000, renderTimeoutMs: 2000, settleMs: 100, captureScreenshots: false }, 'unused');
    assert.equal(mutationCalls, 0);
    assert.equal(result.status, 'unknown');
    assert.equal(result.policy.blockedMutatingReads, 2);
    assert.ok(result.issues.some(issue => issue.kind === 'read-only-block'));
    assert.ok(result.checkedAt);
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
