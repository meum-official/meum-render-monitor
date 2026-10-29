import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BUSINESS_SOURCE_FILES } from '../business-contracts.mjs';
import { runBusinessScenarios, surveyReadbackMatches } from '../business.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceKeys = ['survey-api', 'survey-modal', 'survey-admin', 'survey-routes', 'survey-service', 'survey-eligibility', 'survey-target-ui', 'survey-state', 'survey-loading', 'survey-policy', 'survey-results-service', 'survey-backend-fixture-test', 'survey-validator', 'business-survey-server'];
const sourcePresent = sourceKeys.every(key => BUSINESS_SOURCE_FILES[key] && existsSync(path.join(root, BUSINESS_SOURCE_FILES[key]))) && existsSync(path.join(root, '8302_adminMeum-master/node_modules/vite'));
const sourceRequired = { skip: sourcePresent ? false : 'approved current creator-feedback Vue/backend/memory-harness sources or their installed dependencies are absent', timeout: 120000 };
const browserRequired = { ...sourceRequired, skip: !sourcePresent ? sourceRequired.skip : process.env.RUN_BUSINESS_BROWSER_TESTS !== '1' ? 'opt in with RUN_BUSINESS_BROWSER_TESTS=1 for localhost synthetic browser tests' : false, timeout: 180000 };
const answers = [{ question_id: 101, answer_text: 'synthetic monitor improvement' }, { question_id: 102, answer_text: 'synthetic monitor reason' }];

async function withFixture(name, run, options) {
  const startedAt = new Date().toISOString();
  const directory = path.join(root, 'tools/meum-render-monitor/data', `business-survey-${name}-${startedAt.replaceAll(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { recursive: true });
  const summary = { schemaVersion: 1, name, startedAt, fixtureOnly: true, accountSource: 'existing creatorVoc.test.js identities 7/8', evidenceScope: 'fixture', status: 'failed', exitCode: 1, checks: 0, limits: ['JWT middleware and Sequelize models are replaced by localhost synthetic role/memory boundaries', 'No production database, customer accounts, captures, deploy or external provider is used', 'Fixture evidence cannot prove actual-app authorization or MySQL locking'] };
  let fixture;
  try {
    const { createSurveyBusinessFixture } = await import('../fixtures/business/survey-server.mjs');
    fixture = await createSurveyBusinessFixture(directory, options);
    summary.sourceProof = fixture.sourceProof;
    summary.before = fixture.counts();
    summary.checks = await run(fixture);
    summary.status = 'passed';
    summary.exitCode = 0;
  } finally {
    summary.completedAt = new Date().toISOString();
    if (fixture) {
      summary.after = fixture.counts();
      summary.requests = fixture.requestSummary();
      await fixture.server.close();
    }
    await writeFile(path.join(directory, 'safe-test-summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ test: name, startedAt, completedAt: summary.completedAt, status: summary.status, exitCode: summary.exitCode, checks: summary.checks, evidenceScope: 'fixture' }));
  }
}

async function request(fixture, role, pathname, body) {
  const response = await fetch(new URL(pathname, fixture.origin), { method: body ? 'POST' : 'GET', headers: { 'X-Meum-Monitor-Test-Role': role, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.json() };
}

test('actual survey eligibility/routes reject excluded, staff and impersonated synthetic actors without answer writes', sourceRequired, async () => {
  await withFixture('eligibility', async fixture => {
    const included = await request(fixture, 'eligible-creator', '/surveys/creator-voc');
    assert.equal(included.status, 200);
    assert.equal(included.body.eligibility.eligible, true);
    assert.equal(included.body.survey.id, 11);
    assert.deepEqual(included.body.survey.questions.map(row => row.id), [101, 102]);
    assert.equal(included.body.state.can_auto_prompt, true);
    const before = fixture.counts();
    for (const role of ['excluded-creator', 'staff', 'impersonated-creator']) {
      const excluded = await request(fixture, role, '/surveys/creator-voc');
      assert.equal(excluded.body.eligibility.eligible, false, role);
      const denied = await request(fixture, role, '/surveys/11/creator-voc/answers', { request_key: 'synthetic-excluded-request-0001', answers });
      assert.equal(denied.status, 403, role);
    }
    assert.deepEqual(fixture.counts(), before);
    assert.equal((await request(fixture, 'eligible-creator', '/surveys/admin/11/results')).status, 403);
    assert.equal((await request(fixture, 'super-admin', '/surveys/admin', { title: 'must never create' })).status, 403);
    assert.equal(fixture.counts().productionMutations, 0);
    assert.equal(fixture.counts().databaseConnections, 0);
    assert.equal(fixture.counts().accountsCreated, 0);
    return 17;
  });
});

test('actual survey submission persists once, independently rereads through admin route and preserves repeated request key', sourceRequired, async () => {
  await withFixture('backend-idempotency', async fixture => {
    const before = await request(fixture, 'super-admin', '/surveys/admin/11/results');
    const payload = { answers, request_key: 'synthetic-survey-request-0001' };
    const saved = await request(fixture, 'eligible-creator', '/surveys/11/creator-voc/answers', payload);
    assert.equal(saved.status, 201);
    assert.equal(saved.body.success, true);
    const responseKey = saved.body.result.response_key;
    const after = await request(fixture, 'super-admin', '/surveys/admin/11/results');
    assert.equal(surveyReadbackMatches(after.body.result, 11, responseKey, answers), true);
    assert.equal(after.body.result.total_responses - before.body.result.total_responses, 1);
    const repeated = await request(fixture, 'eligible-creator', '/surveys/11/creator-voc/answers', payload);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.result.already_submitted, true);
    assert.equal(repeated.body.result.response_key, responseKey);
    assert.equal(fixture.counts().answerRows, 2);
    assert.equal(fixture.counts().responses, 1);
    return 9;
  });
});

test('actual Vue target inclusion/exclusion and UI submission pass only as fixture evidence with independent admin readback', browserRequired, async () => {
  const { launchBrowser } = await import('../probe.mjs');
  const browser = await launchBrowser();
  try {
    await withFixture('ui-pipeline', async fixture => {
      const result = await runBusinessScenarios(browser, { business: { ...fixture, scenarioIds: fixture.scenarioIds } });
      for (const id of fixture.scenarioIds) {
        const row = result.cases.find(row => row.id === id);
        assert.equal(row.status, 'pass', `${id}: ${JSON.stringify({ reason: row.reason, checks: row.checks, observed: row.observed })}`);
        assert.equal(row.evidenceScope, 'fixture');
      }
      assert.equal(result.status, 'blocked');
      assert.equal(fixture.counts().answerRows, 2);
      assert.equal(fixture.counts().responses, 1);
      assert.ok(fixture.requestSummary().some(row => row.path === '/surveys/admin/11/results' && row.role === 'super-admin'));
      return 10;
    });
  } finally { await browser.close(); }
});

test('actual Vue excludes staff and impersonated fixture actors without automatic invitation or answer writes', browserRequired, async () => {
  const { launchBrowser } = await import('../probe.mjs');
  const browser = await launchBrowser();
  try {
    await withFixture('ui-excluded-roles', async fixture => {
      const before = fixture.counts();
      for (const role of ['excluded-creator', 'staff', 'impersonated-creator']) {
        const context = await browser.newContext({ extraHTTPHeaders: { 'X-Meum-Monitor-Test-Role': role } });
        try {
          await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
          await context.routeWebSocket('**/*', socket => socket.close());
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(new URL('/exhibition-dashboard', fixture.origin).href);
          await page.locator('body[data-survey-fixture-ready="true"]').waitFor();
          assert.equal(await page.locator('.creator-feedback-dialog').count(), 1);
          assert.equal(await page.locator('.creator-feedback-invitation').isVisible(), false, role);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }
      assert.deepEqual(fixture.counts(), before);
      return 10;
    });
  } finally { await browser.close(); }
});

test('actual UI success with deliberately missing independent admin answers is rejected by the business runner', browserRequired, async () => {
  const { launchBrowser } = await import('../probe.mjs');
  const browser = await launchBrowser();
  try {
    await withFixture('ui-negative-readback', async fixture => {
      const result = await runBusinessScenarios(browser, { business: { ...fixture, scenarioIds: ['survey-submit-admin-read'] } });
      const row = result.cases.find(row => row.id === 'survey-submit-admin-read');
      assert.equal(row.observed?.submissionSucceeded, true, row.reason);
      assert.equal(row.observed?.adminReadMatches, false);
      assert.equal(row.status, 'fail');
      assert.equal(result.status, 'fail');
      assert.equal(fixture.counts().answerRows, 2, 'actual service saved the synthetic response despite faulted admin presentation');
      assert.equal(fixture.counts().responses, 1);
      return 6;
    }, { adminReadback: 'missing' });
  } finally { await browser.close(); }
});
