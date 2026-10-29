import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePublicRoomId } from '../journey-contracts.mjs';
import { expectedGuestCases, prepareCheckpoint, restoreCheckpoint, sanitizeCiState, sanitizeStatus, publicTargetUrl } from '../checkpoint.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const secret = 'SYNTHETIC_PRIVATE_CHECKPOINT_VALUE';
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const viewport = { name: 'desktop', width: 1440, height: 1000 };
const row = (url = 'https://meum.me/plan', patch = {}) => ({
  url, id: createHash('sha256').update(url + viewport.name).digest('hex').slice(0, 20), viewport, name: secret, checkedAt: now(), status: 'pass', policy: { readOnly: true },
  layers: { render: { required: true, status: 'pass', evidenceScope: 'public-readonly', checks: [{ name: secret, passed: true }] }, navigation: { required: true, status: 'pass', evidenceScope: 'public-instrumented', cases: expectedGuestCases({ url }).map(definition => ({ ...definition, name: secret, role: 'guest', viewport: definition.mode === 'mobile' ? 'mobile' : 'desktop', status: definition.required ? 'pass' : 'not-run', reason: secret, checks: definition.required ? [{ name: secret, passed: true, detail: secret }] : [], observed: { url: secret, payload: secret } })) }, business: { required: false, status: 'not-run' } },
  ...patch,
});
const ciState = () => ({ schemaVersion: 1, mode: 'after-deploy', fingerprints: { 'https://meum.me/home': 'a'.repeat(64), 'https://archive.meum.me/': 'b'.repeat(64) }, watchUntil: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), lastGateAt: now(), reason: 'fingerprint-check-failed', shouldRun: true, resetCycle: false, errorFingerprint: 'c'.repeat(64), errors: [secret] });
const state = (results = [row()]) => ({ schemaVersion: 2, status: 'completed', runId: `run-${Date.now()}-abcdef`, inventorySignature: 'd'.repeat(64), continuation: true, startedAt: now(), attemptStartedAt: now(), completedAt: now(), intervalMinutes: 60, mode: 'after-deploy', results, discovery: { complete: true, totalTargets: results.length, totalExhibitions: 1, source: secret, errors: [] }, businessVerification: { status: 'pass', checkedAt: now(), role: secret, cases: [{ role: secret, observed: { password: secret } }] }, history: [{ title: secret }], fixtureEvidence: { logs: secret } });

async function fixture(run) {
  const base = path.resolve(root, 'data'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'checkpoint-synthetic-test-'));
  const dataDir = path.join(directory, 'private-data'), checkpointDir = path.join(directory, '.monitor-checkpoint'), restoredDir = path.join(directory, 'restored');
  await mkdir(dataDir); await mkdir(checkpointDir);
  try { await run({ directory, dataDir, checkpointDir, restoredDir }); }
  finally { assert.equal(path.dirname(path.resolve(directory)), base); assert.ok(path.basename(directory).startsWith('checkpoint-synthetic-test-')); await rm(directory, { recursive: true, force: true }); }
}

test('CI allowlist retains fixed fingerprints and outage transition hash, never raw errors or private URLs', () => {
  const source = ciState(); source.fingerprints[`https://private.invalid/?token=${secret}`] = 'e'.repeat(64); source.observed = { secret };
  const safe = sanitizeCiState(source);
  assert.deepEqual(Object.keys(safe.fingerprints), ['https://meum.me/home', 'https://archive.meum.me/']);
  assert.equal(safe.errorFingerprint, source.errorFingerprint);
  assert.equal(safe.resetCycle, false); assert.equal(safe.shouldRun, true);
  assert.equal(JSON.stringify(safe).includes(secret), false);
  assert.equal(Object.hasOwn(safe, 'errors'), false);
});

test('public URL validation rejects auth/private/query/userinfo paths and binds viewer Hashids to its public parent', () => {
  const parent = 'https://meum.me/exhibition/preview/10001';
  const parents = new Set([parent]);
  const viewer = `https://meum.me/meum-lite-viewer?r=${encodePublicRoomId(10001)}`;
  assert.equal(publicTargetUrl(viewer, { parentUrl: parent, parents }), viewer);
  for (const value of ['https://meum.me/home', 'https://meum.me/plan', parent, 'https://archive.meum.me/', 'https://archive.meum.me/archive/viewer/10001']) assert.equal(publicTargetUrl(value), value);
  for (const value of [
    'https://meum.me/login', 'https://meum.me/register', 'https://meum.me/exhibition/invitation/123',
    'https://meum.me/admin', 'https://meum.me/account', 'https://backend.meum.me/room/list',
    `https://owner:${secret}@meum.me/home`, `https://meum.me/home?token=${secret}`, `https://meum.me/home#${secret}`,
    'http://meum.me/home', 'https://meum.me/exhibition/preview/001',
    `https://meum.me/meum-lite-viewer?r=${encodePublicRoomId(10002)}`, `${viewer}&token=${secret}`, `${viewer}&r=duplicate`,
  ]) assert.equal(publicTargetUrl(value, { parentUrl: parent, parents }), null, value.replace(secret, '[synthetic]'));
  assert.equal(publicTargetUrl(viewer), null);
  assert.equal(publicTargetUrl(viewer, { parentUrl: parent, parents: new Set() }), null);
});

test('public resume summary strips authenticated fields and preserves valid public progress', () => {
  const source = state();
  Object.assign(source.results[0], { screenshot: `/screenshots/${secret}.png`, title: secret, observed: { secret }, payload: { secret }, request: secret, issues: [{ message: secret }], logs: secret });
  source.results[0].layers.navigation.cases[0].observed = { secret };
  const safe = sanitizeStatus(source);
  assert.equal(safe.results[0].status, 'pass');
  assert.equal(safe.results[0].checkedAt, source.results[0].checkedAt);
  assert.equal(safe.results[0].url, source.results[0].url);
  assert.equal(safe.results[0].id, source.results[0].id);
  assert.deepEqual(safe.results[0].viewport, viewport);
  assert.equal(safe.continuation, true); assert.equal(safe.inventorySignature, source.inventorySignature);
  assert.equal(safe.businessVerification.status, 'not-run'); assert.deepEqual(safe.businessVerification.cases, []);
  assert.equal(JSON.stringify(safe).includes(secret), false);
  for (const field of ['screenshot', 'observed', 'payload', 'role', 'fixtureEvidence', 'logs']) assert.equal(JSON.stringify(safe).includes(`"${field}":`), false, field);
  assert.equal(source.businessVerification.status, 'pass');
});

test('false timestamps, unproved public passes and unsafe discovered entries force a fresh guest check', () => {
  const falseTime = row(); falseTime.checkedAt = false;
  const absentProof = row('https://meum.me/home'); absentProof.policy.readOnly = false;
  const privateRole = row('https://meum.me/exhibition'); privateRole.layers.navigation.cases[0].role = 'owner';
  const parent = row('https://meum.me/exhibition/preview/10001'); parent.discoveredPages = [{ url: `https://meum.me/meum-lite-viewer?r=${secret}`, name: secret, discoveredFrom: parent.url }];
  const safe = sanitizeStatus(state([falseTime, absentProof, privateRole, parent]));
  for (const result of safe.results) { assert.equal(result.checkedAt, null); assert.notEqual(result.status, 'pass'); }
  assert.equal(Object.hasOwn(safe.results.at(-1), 'discoveredPages'), false);
  assert.equal(JSON.stringify(safe).includes(secret), false);
});

test('cache requires every registered public mode and action, without duplicate or mismatched cases', () => {
  const directOnly = row(); directOnly.layers.navigation.cases = directOnly.layers.navigation.cases.filter(item => item.id === 'direct');
  const missingArrival = row('https://meum.me/exhibition/preview/10001'); missingArrival.layers.navigation.cases = missingArrival.layers.navigation.cases.filter(item => item.id !== 'enter-arrival');
  const missingPositive = row('https://meum.me/exhibition'); missingPositive.layers.navigation.cases = missingPositive.layers.navigation.cases.filter(item => item.id !== 'search-known-positive');
  const duplicated = row(); duplicated.layers.navigation.cases.push({ ...duplicated.layers.navigation.cases[0] });
  const wrongMode = row(); wrongMode.layers.navigation.cases[0].mode = 'reload';
  const hiddenRequired = row(); hiddenRequired.layers.navigation.cases[0].required = false;
  for (const source of [directOnly, missingArrival, missingPositive, duplicated, wrongMode, hiddenRequired]) {
    const safe = sanitizeStatus(state([source])).results[0];
    assert.equal(safe.checkedAt, null); assert.notEqual(safe.status, 'pass');
  }
  const requiredOnly = row(); requiredOnly.layers.navigation.cases = requiredOnly.layers.navigation.cases.filter(item => item.required);
  const complete = sanitizeStatus(state([requiredOnly])).results[0];
  assert.equal(complete.status, 'pass'); assert.equal(complete.checkedAt, requiredOnly.checkedAt);
});

test('case timestamps retain the oldest public evidence and never hide invalid or future clocks', () => {
  const source = row(); const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  source.layers.navigation.checkedAt = now(); source.layers.navigation.cases[0].checkedAt = old;
  const safe = sanitizeStatus(state([source])).results[0];
  assert.equal(safe.layers.navigation.cases[0].checkedAt, old);
  assert.ok(safe.layers.navigation.cases.filter(item => item.required).every(item => item.checkedAt));
  for (const invalid of [false, null, new Date(Date.now() + 60 * 60 * 1000).toISOString()]) {
    const bad = row(); bad.layers.navigation.cases[0].checkedAt = invalid;
    const result = sanitizeStatus(state([bad])).results[0];
    assert.equal(result.checkedAt, null); assert.notEqual(result.status, 'pass');
  }
});

test('verified public viewer discovery and unchecked dynamic target survive resume without customer titles', () => {
  const parent = row('https://meum.me/exhibition/preview/10001');
  const url = `https://meum.me/meum-lite-viewer?r=${encodePublicRoomId(10001)}`;
  parent.discoveredPages = [{ url, name: secret, group: '3D 관람', discoveredFrom: parent.url }];
  const viewer = row(url, { discoveredFrom: parent.url, checkedAt: null, status: 'pending' });
  viewer.layers.navigation = { required: true, status: 'unregistered', cases: [] };
  const safe = sanitizeStatus(state([parent, viewer]));
  assert.equal(safe.results.length, 2);
  assert.equal(safe.results[0].checkedAt, parent.checkedAt);
  assert.equal(safe.results[0].discoveredPages[0].url, url);
  assert.equal(safe.results[1].url, url); assert.equal(safe.results[1].discoveredFrom, parent.url);
  assert.equal(safe.results[1].checkedAt, null); assert.notEqual(safe.results[1].status, 'pass');
  assert.equal(JSON.stringify(safe).includes(secret), false);
  parent.role = 'owner';
  const authenticated = sanitizeStatus(state([parent, viewer]));
  assert.equal(authenticated.results.length, 1);
  assert.equal(authenticated.results[0].checkedAt, null);
  assert.equal(Object.hasOwn(authenticated.results[0], 'discoveredPages'), false);
});

test('verified viewer checkpoint roundtrip retains parent identity and target envelope', async () => {
  await fixture(async ({ dataDir, checkpointDir, restoredDir }) => {
    const parent = row('https://meum.me/exhibition/preview/10001');
    const url = `https://meum.me/meum-lite-viewer?r=${encodePublicRoomId(10001)}`;
    parent.discoveredPages = [{ url, discoveredFrom: parent.url, name: secret }];
    const viewer = row(url, { discoveredFrom: parent.url, checkedAt: null, status: 'unknown' });
    viewer.layers.navigation = { required: true, status: 'unregistered', cases: [] };
    await writeFile(path.join(dataDir, 'ci-state.json'), JSON.stringify(ciState()));
    await writeFile(path.join(dataDir, 'status.json'), JSON.stringify(state([parent, viewer])));
    await prepareCheckpoint({ dataDir, checkpointDir });
    const restored = await restoreCheckpoint({ dataDir: restoredDir, checkpointDir });
    assert.equal(restored.status.results.length, 2);
    assert.equal(restored.status.results[0].discoveredPages[0].url, url);
    assert.equal(restored.status.results[1].discoveredFrom, parent.url);
    assert.deepEqual(restored.status.results[1].viewport, viewport);
    assert.equal(restored.status.results[1].id, viewer.id);
    assert.equal(restored.status.results[1].checkedAt, null);
  });
});

test('checkpoint writes only two validated JSON files; local captures/logs remain private and untouched', async () => {
  await fixture(async ({ dataDir, checkpointDir, restoredDir }) => {
    const source = state();
    await writeFile(path.join(dataDir, 'ci-state.json'), JSON.stringify(ciState()));
    const original = JSON.stringify(source); await writeFile(path.join(dataDir, 'status.json'), original);
    await mkdir(path.join(dataDir, 'screenshots')); await writeFile(path.join(dataDir, 'screenshots', 'synthetic.png'), secret);
    await writeFile(path.join(dataDir, 'business-harness.log'), secret);
    await writeFile(path.join(checkpointDir, 'old-private.log'), secret);
    await prepareCheckpoint({ dataDir, checkpointDir });
    assert.deepEqual((await readdir(checkpointDir)).sort(), ['ci-state.json', 'status.json']);
    for (const filename of await readdir(checkpointDir)) assert.equal((await readFile(path.join(checkpointDir, filename), 'utf8')).includes(secret), false);
    assert.equal(await readFile(path.join(dataDir, 'status.json'), 'utf8'), original);
    assert.equal(await readFile(path.join(dataDir, 'business-harness.log'), 'utf8'), secret);
    const restored = await restoreCheckpoint({ dataDir: restoredDir, checkpointDir });
    assert.equal(restored.status.results[0].checkedAt, source.results[0].checkedAt);
    assert.equal(restored.status.continuation, true);
    assert.equal(restored.ci.errorFingerprint, 'c'.repeat(64));
    assert.deepEqual((await readdir(restoredDir)).sort(), ['ci-state.json', 'status.json']);
  });
});

test('strict restore rejects extra files, bad metadata and payload tampering without replacing local state', async () => {
  await fixture(async ({ dataDir, checkpointDir, restoredDir }) => {
    await writeFile(path.join(dataDir, 'ci-state.json'), JSON.stringify(ciState())); await writeFile(path.join(dataDir, 'status.json'), JSON.stringify(state()));
    await prepareCheckpoint({ dataDir, checkpointDir });
    await mkdir(restoredDir); await writeFile(path.join(restoredDir, 'status.json'), 'existing synthetic private state');
    await writeFile(path.join(checkpointDir, 'unexpected.png'), secret);
    await assert.rejects(() => restoreCheckpoint({ dataDir: restoredDir, checkpointDir }), /두 JSON/);
    await prepareCheckpoint({ dataDir, checkpointDir });
    const ci = JSON.parse(await readFile(path.join(checkpointDir, 'ci-state.json'), 'utf8'));
    const saved = JSON.parse(await readFile(path.join(checkpointDir, 'status.json'), 'utf8'));
    saved.data.results[0].observed = { secret };
    saved.metadata.payloadSha256 = digest(saved.data); const pair = digest([ci.data, saved.data]); ci.metadata.pairSha256 = pair; saved.metadata.pairSha256 = pair;
    await writeFile(path.join(checkpointDir, 'ci-state.json'), JSON.stringify(ci)); await writeFile(path.join(checkpointDir, 'status.json'), JSON.stringify(saved));
    await assert.rejects(() => restoreCheckpoint({ dataDir: restoredDir, checkpointDir }), /허용되지 않은/);
    assert.equal(await readFile(path.join(restoredDir, 'status.json'), 'utf8'), 'existing synthetic private state');
    saved.metadata.policy = secret; await writeFile(path.join(checkpointDir, 'status.json'), JSON.stringify(saved));
    await assert.rejects(() => restoreCheckpoint({ dataDir: restoredDir, checkpointDir }), error => !error.message.includes(secret));
  });
});

test('duplicate or mismatched target IDs cannot retain a cached pass', () => {
  const original = row();
  const duplicate = sanitizeStatus(state([original, { ...original }]));
  assert.equal(duplicate.results.length, 1); assert.equal(duplicate.results[0].checkedAt, null); assert.notEqual(duplicate.results[0].status, 'pass');
  const invalid = row(); invalid.id = 'f'.repeat(20);
  assert.equal(sanitizeStatus(state([invalid])).results.length, 0);
});

test('production workflow keeps public-doc restoration and diagnostic hold separate from manual checkpoints', async () => {
  const workflow = await readFile(path.join(root, '.github', 'workflows', 'render-check.yml'), 'utf8');
  assert.equal(workflow.includes('meum-monitor-state-'), false);
  assert.doesNotMatch(workflow, /uses: actions\/cache\//);
  assert.match(workflow, /node publish-report\.mjs restore/);
  assert.match(workflow, /MONITOR_DIAGNOSTIC_HOLD/);
  assert.match(workflow, /github\.run_attempt == 1/);
  assert.match(workflow, /run: node publish-report\.mjs\s*$/m);
});
