import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createReadonlyBackendFixture, createReadonlyBusinessFixture } from '../fixtures/business/readonly-server.mjs';
import { runBusinessScenarios, verifyBusinessEnvironment } from '../business.mjs';
import { launchBrowser } from '../probe.mjs';
import { installReadOnlyGuard } from '../safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const available = await Promise.all([
  '8302_adminMeum-master/tests/invitationExperiencePolish.browser.mjs',
  '8302_adminMeum-master/src/components/exhibition/experience/ExhibitionExperience.vue',
  '8080_meum-backend-api-develop/meum-backend-api-develop/.api/rooms/rooms.js',
].map(filename => access(path.join(root, filename)).then(() => true, () => false))).then(values => values.every(Boolean));
const absent = 'approved current Admin/Experience and backend source fixtures are absent in this standalone checkout';

test('CURRENT backend handler and role policy deny the preexisting readonly participant before any transaction/save', { skip: available ? false : absent }, async () => {
  const policy = await createReadonlyBackendFixture();
  const before = policy.snapshot();
  const response = await policy.denySave({ room_id: 991002, solution_json: before.solution_json });
  assert.equal(response.status, 403);
  assert.equal(response.body.success, false);
  assert.deepEqual(policy.snapshot(), before);
  assert.equal(policy.counters.policyInvocations, 1);
  assert.ok(policy.counters.inviteReads > 0);
  assert.equal(policy.counters.transactions, 0);
  assert.equal(policy.counters.roomSaves, 0);
  assert.equal(Object.keys(policy.sourceHashes).length, 4);
});

test('CURRENT actual Admin Experience UI + HTTP mock server: disabled controls, source-policy403, independentGET unchanged', {
  skip: !available ? absent : process.env.RUN_BUSINESS_BROWSER_TESTS !== '1', timeout: 240000,
}, async () => {
  const startedAt = new Date().toISOString();
  const directory = path.join(root, 'tools/meum-render-monitor/data/business-harness', `readonly-pipeline-${Date.now()}-${randomBytes(3).toString('hex')}`);
  await mkdir(directory, { recursive: true });
  let environment, browser;
  const report = { schemaVersion: 1, status: 'running', startedAt, evidenceScope: 'fixture', actualAppBusinessStatus: 'blocked', command: 'RUN_BUSINESS_BROWSER_TESTS=1 node --test test/business-readonly.test.mjs', productionRequests: 0, databaseConnections: 0, accountsCreated: 0, checks: [] };
  try {
    environment = await createReadonlyBusinessFixture(directory);
    const manifest = await verifyBusinessEnvironment(environment);
    assert.equal(manifest.negativePermissionProbes, true);
    assert.equal(manifest.kind, 'fixture');
    report.checks.push('hash-pinned manifest/current source proofs/server-side isolation marker agree');
    browser = await launchBrowser();
    // Warm only the actual fixture module graph; cold Vite compilation is not an application timeout.
    const warm = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1536, height: 900 } });
    try {
      const blocked = await installReadOnlyGuard(warm, [environment.origin]);
      const page = await warm.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(String(error.message).slice(0, 600)));
      const settingsRead = page.waitForResponse(response => new URL(response.url()).pathname === '/mock/api/rooms/comment-settings/991002', { timeout: 120000 });
      const roseRead = page.waitForResponse(response => new URL(response.url()).pathname === '/mock/api/rooms/991002/roses/settings', { timeout: 120000 });
      settingsRead.catch(() => {}); roseRead.catch(() => {});
      try {
        await page.goto(environment.origin + '/exhibition/experience', { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction(() => window.actualShellMounted && window.experience && document.querySelector('.experience-page .save-btn'), null, { timeout: 30000 });
        assert.equal((await settingsRead).status(), 200); assert.equal((await roseRead).status(), 200);
        assert.equal(await page.evaluate(() => window.fixture.store.state.userInfo.is_auth), 2);
      } catch (error) {
        report.warmDiagnostics = { errors, requests: environment.requests, rejected: environment.rejected, dom: await page.evaluate(() => ({ hasActualShell: !!window.actualShellMounted, hasExperience: !!window.experience, experienceKeys: Object.keys(window.experience || {}), role: window.fixture?.store.state.userInfo.is_auth, roomId: window.fixture?.store.state.userInfo.roomId, hasPage: !!document.querySelector('.experience-page'), title: document.title, text: document.body.innerText.slice(0, 800) })).catch(() => null) };
        throw error;
      }
      assert.equal(await page.locator('.experience-page .save-btn').isDisabled(), true);
      const toggles = page.locator('.experience-page .toggle-btn');
      assert.ok(await toggles.count() >= 5);
      for (const toggle of await toggles.all()) assert.equal(await toggle.isDisabled(), true);
      assert.deepEqual(blocked.filter(request => request.kind === 'write-request'), []);
      report.checks.push('current actual Admin.vue/ExhibitionExperience.vue mounted and every readonly toggle/save control is disabled');
    } finally { await warm.close(); }
    const baseline = environment.policy.snapshot();
    const result = await runBusinessScenarios(browser, { business: environment });
    const row = result.cases.find(item => item.id === 'viewer-settings-readonly');
    assert.equal(row.status, 'pass', JSON.stringify({ reason: row.reason, checks: row.checks }));
    assert.equal(row.evidenceScope, 'fixture');
    assert.equal(row.actualAppValidated, false);
    assert.equal(result.status, 'blocked');
    assert.equal(row.checks.length, 3);
    assert.ok(row.checks.every(check => check.passed === true));
    assert.deepEqual(environment.policy.snapshot(), baseline);
    assert.equal(environment.policy.counters.policyInvocations, 1);
    assert.ok(environment.policy.counters.inviteReads > 0);
    assert.equal(environment.policy.counters.roomSaves, 0);
    assert.equal(environment.policy.counters.transactions, 0);
    assert.ok(environment.requests.some(request => request.path === '/api/rooms/comment-settings/991002'));
    assert.ok(environment.requests.some(request => request.path === '/api/rooms/991002/roses/settings'));
    assert.ok(environment.requests.filter(request => request.path === '/user/room/detail').length >= 2);
    assert.deepEqual(environment.rejected, []);
    report.checks.push('actual UI uses same HTTP mock server for comment/rose settings reads', 'independent pre/post GET matches persisted memory state', 'CURRENT backend update_room/organization role policy returns403', 'zero memory saves or transactions');
    Object.assign(report, { status: 'pass', scenario: row, readonlyCaseChecks: row.checks.length, evidence: environment.evidence, counters: environment.policy.counters, requestCounts: { reads: environment.requests.filter(request => request.method === 'GET').length, negativePatches: environment.requests.filter(request => request.method === 'PATCH').length }, sourceProof: environment.sourceProof, backendVmSourceHashes: environment.policy.sourceHashes, limitations: ['Actual current UI and current authorization/route code use mocked identity, plans, workspace and DB models.', 'JWT middleware/input validators, real account authentication, production, actual DB and real-app isolated server remain unvalidated.'] });
    environment.injectResponseFault('negative-patch-http200');
    const counterexample = await runBusinessScenarios(browser, { business: environment });
    const broken = counterexample.cases.find(item => item.id === 'viewer-settings-readonly');
    assert.equal(broken.status, 'fail');
    assert.equal(broken.observed.controlsDisabled, true);
    assert.equal(broken.observed.readbackUnchanged, true);
    assert.equal(broken.observed.serverRejected, false);
    assert.equal(environment.policy.counters.roomSaves, 0);
    assert.equal(environment.policy.counters.transactions, 0);
    assert.deepEqual(environment.policy.snapshot(), baseline);
    report.counterexample = { injection: 'fixture HTTP response changed to200 after current source policy still denies', detected: true, scenario: broken, productionRequests: 0, memorySaves: 0 };
    report.checks.push('counterexample HTTP200 is detected as failure despite readonly UI and unchanged data');
  } catch (error) {
    Object.assign(report, { status: 'fail', error: String(error.message).slice(0, 1200), counters: environment?.policy.counters });
    throw error;
  } finally {
    await browser?.close(); await environment?.server.close();
    report.completedAt = new Date().toISOString();
    report.exitCode = report.status === 'pass' ? 0 : 1;
    await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ readonlyPipeline: report.status, exitCode: report.exitCode, checks: report.checks.length, completedAt: report.completedAt, evidence: path.relative(root, path.join(directory, 'result.json')).replaceAll('\\', '/') }));
  }
});
