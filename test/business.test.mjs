import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BUSINESS_CONTRACTS, BUSINESS_SOURCE_FILES, businessContract } from '../business-contracts.mjs';
import { isolatedOrigin, verifyBusinessEnvironment, businessRequestPermission, validateBusinessObservation, runBusinessScenarios, businessAdapterCapabilities, autoInstallObservation, surveyReadbackMatches, actualAppReadiness } from '../business.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceFilesPresent = await Promise.all(['admin-experience-ui', 'admin-room-read'].map(id => access(path.join(root, BUSINESS_SOURCE_FILES[id])).then(() => true, () => false))).then(values => values.every(Boolean));
const sourceRequired = { skip: sourceFilesPresent ? false : 'approved monorepo source proof is absent in this standalone checkout' };
const autoSourcePresent = await access(path.join(root, '8080_meum-backend-api-develop/meum-backend-api-develop/services/roomService.js')).then(() => true, () => false);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const folders = [];
after(async () => {
  for (const folder of folders) {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith('meum-business-test-'));
    await rm(folder, { recursive: true, force: true });
  }
});
const plainManifest = () => ({
  schemaVersion: 1, environmentId: 'business-unit-fixture-only', kind: 'fixture',
  adapter: 'source-ui-http-fixture-v1', origin: 'http://127.0.0.1:19011', serverGuardId: 'meum-memory-business-fixture-v1',
  productionForwarding: false, existingAccountsOnly: true, database: { mode: 'memory' },
  dataset: { roomId: 991001, landId: 41, itemIds: [991002, 991003], surveyId: 991004, existing: true },
  roles: { owner: 'existing-fixture-owner', 'invited-admin': 'existing-fixture-admin', 'read-only': 'existing-fixture-reader', 'eligible-creator': 'existing-fixture-creator', payer: 'fixture' },
  scenarios: { 'viewer-settings-owner': { pagePath: '/exhibition/experience' } },
});
async function prepared(patch = {}) {
  const manifest = { ...plainManifest(), ...patch };
  if (!manifest.sourceProof) {
    manifest.sourceProof = {};
    for (const id of ['admin-experience-ui', 'admin-room-read']) manifest.sourceProof[id] = hash(await readFile(path.join(root, BUSINESS_SOURCE_FILES[id])));
  }
  const folder = await mkdtemp(path.join(tmpdir(), 'meum-business-test-'));
  folders.push(folder);
  const manifestPath = path.join(folder, 'manifest.json');
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(manifestPath, bytes);
  const config = { manifestPath, manifestSha256: hash(bytes) };
  const marker = { environmentId: manifest.environmentId, manifestSha256: config.manifestSha256, serverGuardId: manifest.serverGuardId, productionForwarding: false, mutationsRestrictedToDataset: true, existingAccountsOnly: true, dataset: manifest.dataset, roles: manifest.roles };
  return { config, manifest, marker };
}
const checksPass = (id, observed) => validateBusinessObservation(id, observed).every(check => check.passed);
const paid = (extra = {}) => ({
  externalNetworkCalls: 0, sdkLoads: 0, trialStatus: 'expired',
  paid: { id: 2, plan_code: 'project_3month', status: 'active', start_at: '2026-10-26T00:00:00+09:00' },
  prepared: { amount: 550000, target_type: 'personal', target_id: 'fixture' },
  fulfillmentCount: 1, trialTransitionCount: 1, readbackVerified: true, idempotent: true, ...extra,
});

test('default denies all eleven writes/payments without opening a browser or querying a service', async () => {
  let browserCalls = 0;
  const result = await runBusinessScenarios({ newContext: () => { browserCalls++; throw Error('must not open'); } });
  assert.equal(result.status, 'blocked');
  assert.equal(result.cases.length, 11);
  assert.ok(result.cases.every(row => row.status === 'blocked' && row.evidenceScope === 'blocked' && row.checkedAt === null));
  assert.equal(browserCalls, 0);
});

test('selection never hides missing business coverage; empty selection stays not-run', async () => {
  const selected = await runBusinessScenarios(null, { business: { scenarioIds: ['auto-install'] } });
  assert.equal(selected.cases.length, 11);
  assert.equal(selected.cases.filter(row => row.status === 'not-run').length, 10);
  const none = await runBusinessScenarios(null, { business: { scenarioIds: [] } });
  assert.equal(none.status, 'not-run');
  assert.equal(none.cases.length, 11);
  const unknown = await runBusinessScenarios(null, { business: { scenarioIds: ['unknown-case'] } });
  assert.equal(unknown.status, 'unregistered');
  assert.ok(unknown.cases.some(row => row.status === 'unregistered'));
});

test('production, DNS hostnames, embedded credentials, and missing-port targets are rejected', () => {
  for (const origin of ['https://meum.me', 'https://backend.meum.me', 'http://localhost:19011', 'http://127.0.0.1', 'http://user:pass@127.0.0.1:19011']) assert.throws(() => isolatedOrigin(origin));
  assert.equal(isolatedOrigin('http://127.0.0.1:19011'), 'http://127.0.0.1:19011');
});

test('fixture roles and source coverage never establish existing actual-app accounts or session support', () => {
  const actual = actualAppReadiness();
  assert.equal(actual.registeredServerGuards, 0);
  assert.equal(actual.actualAppAdapterImplemented, false);
  assert.equal(actual.existingAccountsVerified, false);
  assert.equal(actual.datasetVerified, false);
  assert.equal(actual.authenticationTransport, 'fixture-role-header-only');
  const forged = { ...plainManifest(), origin: 'https://backend.meum.me' };
  assert.ok(businessRequestPermission(forged, businessContract('viewer-settings-owner'), 'PATCH', forged.origin + '/api/rooms/update_room', { room_id: 991001, solution_json: '{}' }));
});

test('a reviewed source hash, exact manifest pin, and matching server-side marker are all required', sourceRequired, async () => {
  const good = await prepared();
  const result = await verifyBusinessEnvironment(good.config, async () => ({ ok: true, json: async () => good.marker }));
  assert.equal(result.environmentId, good.manifest.environmentId);
  await assert.rejects(() => verifyBusinessEnvironment({ ...good.config, manifestSha256: '0'.repeat(64) }), /해시/);
  await assert.rejects(() => verifyBusinessEnvironment(good.config, async () => ({ ok: true, json: async () => ({ ...good.marker, productionForwarding: true }) })), /marker/);
  await assert.rejects(() => verifyBusinessEnvironment(good.config, async () => ({ ok: true, json: async () => ({ ...good.marker, roles: { owner: 'different-account' } }) })), /marker/);
});

test('an arbitrary environment string or forged real-app label cannot enable writes', async () => {
  const forged = await prepared({ kind: 'isolated-app', serverGuardId: 'trust-me-production-is-safe', sourceProof: {} });
  let fetched = false;
  await assert.rejects(() => verifyBusinessEnvironment(forged.config, async () => { fetched = true; }), /검토·등록/);
  assert.equal(fetched, false);
  const arbitraryFile = await prepared({ sourceProof: { '../.env': '0'.repeat(64) } });
  await assert.rejects(() => verifyBusinessEnvironment(arbitraryFile.config), /임의 경로/);
});

test('mutation guard allows only a registered role, exact room, method, and settings payload', () => {
  const manifest = plainManifest(), contract = businessContract('viewer-settings-owner');
  const body = { room_id: 991001, solution_json: '{"on":[],"off":["chat"]}' };
  const endpoint = `${manifest.origin}/api/rooms/update_room`;
  assert.equal(businessRequestPermission(manifest, contract, 'PATCH', endpoint, body), null);
  assert.ok(businessRequestPermission(manifest, contract, 'PATCH', endpoint, { ...body, room_id: 1 }));
  assert.ok(businessRequestPermission(manifest, contract, 'PATCH', endpoint, { ...body, owner_id: 7 }));
  assert.ok(businessRequestPermission(manifest, businessContract('viewer-settings-readonly'), 'PATCH', endpoint, body));
  assert.ok(businessRequestPermission(manifest, contract, 'POST', endpoint, body));
  assert.ok(businessRequestPermission(manifest, contract, 'PATCH', 'https://backend.meum.me/api/rooms/update_room', body));
  assert.ok(businessRequestPermission(manifest, contract, 'GET', `${manifest.origin}/.env`));
  assert.ok(businessRequestPermission(manifest, contract, 'POST', `${manifest.origin}/user/register`, {}));
});

test('auto-install guard limits both item IDs and target geometry; survey guard rejects actor spoofing', () => {
  const m = plainManifest();
  const auto = businessContract('auto-install');
  const u = `${m.origin}/api/rooms/991001/auto-install`;
  assert.equal(businessRequestPermission(m, auto, 'POST', u, { landId: 41, itemIds: [991002, 991003] }), null);
  assert.ok(businessRequestPermission(m, auto, 'POST', u, { landId: 41, itemIds: [123] }));
  assert.ok(businessRequestPermission(m, auto, 'GET', u));
  const survey = businessContract('survey-submit-admin-read');
  const endpoint = `${m.origin}/surveys/991004/creator-voc/answers`;
  assert.equal(businessRequestPermission(m, survey, 'POST', endpoint, { answers: [], request_key: 'fixture-retry-key' }), null);
  assert.ok(businessRequestPermission(m, survey, 'POST', endpoint, { answers: [], request_key: 'fixture-retry-key', user_id: 999 }));
  assert.ok(businessRequestPermission(m, businessContract('survey-target-excluded'), 'POST', endpoint, { answers: [], request_key: 'fixture' }));
});

test('payment fixtures cannot make even same-origin API mutations', () => {
  const m = { ...plainManifest(), adapter: 'trial-upgrade-component-v1' };
  assert.ok(businessRequestPermission(m, businessContract('payment-success-immediate'), 'POST', `${m.origin}/api/billing/plan/payments/confirm`, {}));
  assert.ok(businessRequestPermission(m, businessContract('payment-success-immediate'), 'POST', 'https://api.portone.io/payments', {}));
});

test('optimistic UI success cannot hide failed persistence or a stale page on re-entry', () => {
  const good = { writeSucceeded: true, readbackMatches: true, freshPageMatches: true, correctRoom: true, roleVerified: true };
  assert.equal(checksPass('viewer-settings-owner', good), true);
  assert.equal(checksPass('viewer-settings-owner', { ...good, readbackMatches: false }), false);
  assert.equal(checksPass('viewer-settings-invited-admin', { ...good, freshPageMatches: false }), false);
});

test('wrong paid plan, duplicate grants, and failed-payment entitlement changes are detected', () => {
  assert.equal(checksPass('payment-success-immediate', paid()), true);
  assert.equal(checksPass('payment-success-immediate', paid({ paid: { status: 'active', plan_code: 'wrong_plan' } })), false);
  assert.equal(checksPass('payment-duplicate-callback', paid({ fulfillmentCount: 2 })), false);
  assert.equal(checksPass('payment-duplicate-callback', paid({ idempotent: false })), false);
  const failure = paid({ trialStatus: 'active', paid: null, fulfillmentCount: 0, trialTransitionCount: 0, bothOutcomesVerified: true });
  assert.equal(checksPass('payment-failure-cancel', failure), true);
  assert.equal(checksPass('payment-failure-cancel', { ...failure, trialStatus: 'expired' }), false);
  assert.equal(checksPass('payment-failure-cancel', { ...failure, bothOutcomesVerified: false }), false);
});

test('scheduled paid access must keep trial and persist the original expiry as its start', () => {
  const value = paid({ trialStatus: 'active', paid: { status: 'pending', plan_code: 'project_3month', start_at: '2026-11-11T00:00:00+09:00' }, trialTransitionCount: 0, originalTrialEnd: '2026-11-11T00:00:00+09:00' });
  assert.equal(checksPass('payment-success-scheduled', value), true);
  assert.equal(checksPass('payment-success-scheduled', { ...value, originalTrialEnd: '2026-11-12' }), false);
});

test('runner independently reads storage after UI save and reports fixture persistence mismatch as failure', sourceRequired, async () => {
  const fixture = await prepared();
  const previous = globalThis.fetch;
  globalThis.fetch = async url => ({ ok: true, json: async () => String(url).includes('/.well-known/') ? fixture.marker : { result: { id: 991001, solution_json: '{"on":["chat"],"off":[]}' } } });
  const locator = { filter() { return this; }, first() { return this; }, locator() { return this; }, async click() {}, async waitFor() {}, async getAttribute() { return 'false'; } };
  const makePage = () => ({ async goto(url) { this.location = url; }, url() { return this.location; }, locator() { return locator; }, async waitForResponse() { return { ok: () => true, json: async () => ({ success: true }) }; }, async close() {} });
  const browser = { async newContext() { return { async route() {}, async addInitScript() {}, async newPage() { return makePage(); }, async close() {} }; } };
  try {
    const result = await runBusinessScenarios(browser, { business: { ...fixture.config, scenarioIds: ['viewer-settings-owner'] } });
    assert.equal(result.status, 'fail');
    assert.equal(result.cases.length, 11);
    const row = result.cases.find(row => row.id === 'viewer-settings-owner');
    assert.equal(row.status, 'fail');
    assert.equal(row.evidenceScope, 'fixture');
    assert.equal(row.checks[0].passed, false);
    assert.equal(result.cases.filter(row => row.status === 'not-run').length, 10);
  } finally { globalThis.fetch = previous; }
});

test('all registered cases declare role, persistence, destination, language and source preconditions', () => {
  assert.equal(new Set(BUSINESS_CONTRACTS.map(row => row.id)).size, 11);
  for (const contract of BUSINESS_CONTRACTS) for (const field of ['role', 'preconditions', 'action', 'expectedPersistence', 'destination', 'language', 'sources']) assert.ok(contract[field]?.length, `${contract.id}.${field}`);
});

test('current actual auto-install method preserves selected IDs and repeated-install invariants in memory', { skip: autoSourcePresent ? false : 'approved backend method/template sources are absent in this standalone checkout' }, async () => {
  const { checkCurrentAutoInstallFixture } = await import('../fixtures/business/auto-install.mjs');
  const evidence = await checkCurrentAutoInstallFixture();
  assert.equal(evidence.status, 'pass');
  assert.equal(evidence.evidenceScope, 'fixture');
  assert.equal(evidence.writes.productionMutations, 0);
  assert.equal(evidence.writes.accountsCreated, 0);
});

test('completed local adapters do not imply a fresh fixture result or actual-app validation', () => {
  for (const id of ['viewer-settings-readonly', 'auto-install', 'survey-target-included', 'survey-target-excluded', 'survey-submit-admin-read']) {
    const metadata = businessAdapterCapabilities(id);
    assert.equal(metadata.contractRegistered, true);
    assert.equal(metadata.executorImplemented, true);
    assert.equal(metadata.adapterImplemented, true);
    assert.equal(metadata.fixtureValidated, false);
    assert.equal(metadata.actualAppValidated, false);
    assert.equal(metadata.actualAppAdapterImplemented, false);
    assert.equal(metadata.executorScope, 'reviewed-ui-http-fixture');
    assert.equal(metadata.adapterBlocker, undefined);
  }
});

test('readonly negative permission probing requires explicit fixture and server-marker approval', () => {
  const manifest = plainManifest();
  const contract = businessContract('viewer-settings-readonly');
  const body = { room_id: 991001, solution_json: '{"on":[],"off":["chat"]}' };
  const endpoint = manifest.origin + '/api/rooms/update_room';
  assert.ok(businessRequestPermission(manifest, contract, 'PATCH', endpoint, body));
  assert.equal(businessRequestPermission({ ...manifest, negativePermissionProbes: true }, contract, 'PATCH', endpoint, body), null);
  assert.ok(businessRequestPermission({ ...manifest, negativePermissionProbes: true }, contract, 'PATCH', endpoint, { ...body, room_id: 12 }));
  assert.equal(checksPass('viewer-settings-readonly', { controlsDisabled: true, serverRejected: true, readbackUnchanged: true }), true);
  assert.equal(checksPass('viewer-settings-readonly', { controlsDisabled: true, serverRejected: false, readbackUnchanged: true }), false);
});

test('actual readonly component save guard performs no memory/API writes', sourceRequired, async () => {
  const { checkReadonlyComponentFixture } = await import('../fixtures/business/readonly.mjs');
  const evidence = await checkReadonlyComponentFixture();
  assert.equal(evidence.status, 'pass'); assert.equal(evidence.evidenceScope, 'fixture');
  assert.equal(evidence.productionMutations, 0); assert.equal(evidence.databaseConnections, 0);
});

test('auto-install readback rejects duplicated/missing items, nonfinite transforms, wrong start point or changed content', () => {
  const transform = { x: 0, y: 1, z: 2 };
  const item = id => ({ object_type_id: 0, artwork_pk: id, assetId: `fixture-${id}`, position: transform, eulerAngle: transform, scale: transform });
  const start = { p: [0, 0, 0], r: [0, 0, 0] };
  const row = { id: 991001, land_type: 41, detail: { title: 'fixture' }, startPoint_json: JSON.stringify(start), data_json: JSON.stringify({ artworks: [item(991002), item(991003)] }) };
  const good = autoInstallObservation(row, row, row, [991002, 991003], start, 41);
  assert.equal(checksPass('auto-install', good), true);
  assert.equal(checksPass('auto-install', autoInstallObservation(row, row, { ...row, detail: { title: 'changed' } }, [991002, 991003], start, 41)), false);
  assert.equal(checksPass('auto-install', autoInstallObservation(row, row, row, [991002], start, 41)), false);
  assert.equal(checksPass('auto-install', autoInstallObservation(row, row, row, [991002, 991003], { p: [1, 0, 0] }, 41)), false);
  assert.equal(checksPass('auto-install', { ...good, finiteTransforms: false }), false);
});

test('survey admin readback checks same survey, question IDs, response identity and exact submitted text', () => {
  const expected = [{ question_id: 11, answer_text: 'fixture main' }, { question_id: 12, answer_text: 'fixture reason' }];
  const result = { survey: { id: 991004 }, questions: expected.map(answer => ({ question: { id: answer.question_id }, text_answers: [{ response_key: 'fixture-response', answer_text: answer.answer_text }] })) };
  assert.equal(surveyReadbackMatches(result, 991004, 'fixture-response', expected), true);
  assert.equal(surveyReadbackMatches(result, 991004, 'another-response', expected), false);
  assert.equal(surveyReadbackMatches(result, 991005, 'fixture-response', expected), false);
  assert.equal(surveyReadbackMatches({ ...result, questions: result.questions.slice(0, 1) }, 991004, 'fixture-response', expected), false);
});

test('existing actual payment Vue components: UI success/scheduled/failure/cancel/duplicate with memory-only persistence', { skip: !sourceFilesPresent ? 'approved app/component harness sources are absent' : process.env.RUN_BUSINESS_BROWSER_TESTS !== '1' && process.env.RUN_BUSINESS_COMPONENT_TESTS !== '1', timeout: 180000 }, async () => {
  const { createPaymentBusinessFixture } = await import('../fixtures/business/payment-server.mjs');
  const { launchBrowser } = await import('../probe.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'meum-business-test-'));
  folders.push(directory);
  const environment = await createPaymentBusinessFixture(directory);
  let browser;
  try {
    browser = await launchBrowser();
    const selected = process.env.BUSINESS_COMPONENT_CASES?.split(',') || environment.scenarioIds;
    const result = await runBusinessScenarios(browser, { business: { ...environment, scenarioIds: selected } });
    console.log(JSON.stringify({ fixtureOnly: true, cases: result.cases.filter(row => selected.includes(row.id)).map(({ id, status, reason, checks, observed }) => ({ id, status, reason, checks, observed })) }));
    for (const row of result.cases.filter(row => selected.includes(row.id))) {
      assert.equal(row.status, 'pass', `${row.id}: ${JSON.stringify({ reason: row.reason, checks: row.checks, observed: row.observed })}`);
      assert.equal(row.evidenceScope, 'fixture');
    }
    assert.equal(result.status, 'blocked', 'component fixture success cannot prove actual app/DB business contracts');
  } finally { await browser?.close(); await environment.server.close(); }
});
