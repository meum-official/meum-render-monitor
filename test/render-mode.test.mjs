import test from 'node:test';
import assert from 'node:assert/strict';
import { renderingConfig, renderReadAllowed, renderLayers, renderSummary, versionEvidence, applyVersionEvidence, renderRuleFor } from '../render-mode.mjs';
import { publicSummary } from '../export-report.mjs';
import { normalizedBusiness, normalizedLayer } from '../public/app.js';
import path from 'node:path';
import { reviewedSourceFile, productSourceRoot } from '../product-source.mjs';
import { createDiagnostics } from '../diagnostic.mjs';

test('render-only configuration cannot enable a journey, business executor or observation callback', () => {
  const config = renderingConfig({ renderOnly: true, functionalNavigation: true, followViewerEntries: true, business: {}, publicObservationPolicy: {}, observePage() {}, pageSpecificationEnabled: true });
  for (const key of ['functionalNavigation', 'followViewerEntries', 'pageSpecificationEnabled']) assert.equal(config[key], false);
  for (const key of ['business', 'publicObservationPolicy', 'observePage']) assert.equal(config[key], undefined);
});
test('authenticated requests, writes and known mutating reads remain denied', () => {
  const request = (url, method = 'GET', headers = {}) => ({ url: () => url, method: () => method, headers: () => headers, isNavigationRequest: () => false });
  for (const url of ['https://backend.meum.me/api/workspaces/my', 'https://backend.meum.me/api/rooms/getDataJson?room_id=1', 'https://backend.meum.me/api/rooms/1/roses']) assert.equal(renderReadAllowed(request(url), []), false);
  assert.equal(renderReadAllowed(request('https://backend.meum.me/room/list', 'POST'), []), false);
  assert.equal(renderReadAllowed(request('https://backend.meum.me/room/list', 'GET', { Authorization: 'synthetic' }), []), false);
  assert.equal(renderReadAllowed(request('https://backend.meum.me/room/list'), []), true);
});
test('unknown revision stays unknown; a mismatch cannot hide a real HTTP error', () => {
  assert.equal(versionEvidence({ monitorRevision: 'private@example.invalid' }).monitorRevision, 'unknown');
  assert.equal(versionEvidence().comparison, 'unknown');
  const evidence = { sourceRevision: 'a'.repeat(40), deployedRevision: 'b'.repeat(40) };
  assert.equal(applyVersionEvidence({ status: 'pass', issues: [] }, evidence).status, 'unknown');
  assert.equal(applyVersionEvidence({ status: 'fail', issues: [{ kind: 'http' }] }, evidence).status, 'fail');
});
test('excluded functions never count as successful or required', () => {
  const result = renderLayers({ status: 'pass', checks: [], issues: [] });
  assert.equal(normalizedLayer(result, 'navigation').required, false);
  assert.equal(normalizedBusiness({ required: false, cases: [] }).required, false);
  const summary = renderSummary([result]);
  assert.equal(summary.render.pass, 1);
  assert.equal(summary.business.total, 0);
  assert.equal(summary.navigation.total, 0);
});
test('semantic title IDs survive decorative class changes and an explicit empty state is allowed', () => {
  assert.deepEqual(renderRuleFor('https://meum.me/school/teacher-guide').selectors, ['#teacher-guide-title', '#teacher-video-title']);
  assert.match(renderRuleFor('https://meum.me/customer-center/notice').selectors[1], /data-render-state/);
});
test('public report exposes only validated version fields and counts, without raw console text', () => {
  const row = { id: '1'.repeat(20), url: 'https://meum.me/home', status: 'pass', checkedAt: new Date().toISOString(), checks: [], issues: [], versions: { monitorRevision: 'private@example.invalid' }, renderDiagnostics: { consoleErrors: 1, consoleText: 'private-console-sentinel' } };
  const report = publicSummary({ renderOnly: true, results: [row], discovery: {} });
  assert.equal(report.businessVerification.required, false);
  assert.equal(report.results[0].versions.monitorRevision, 'unknown');
  assert.equal(report.results[0].renderDiagnostics.consoleErrors, 1);
  assert.ok(!JSON.stringify(report).includes('private-console-sentinel'));
  assert.ok(!JSON.stringify(report).includes('private@example.invalid'));
});
test('optional fixtures resolve monitor files locally and require an explicit product root', () => {
  const previous = process.env.MEUM_PRODUCT_ROOT;
  try {
    delete process.env.MEUM_PRODUCT_ROOT;
    assert.match(reviewedSourceFile('tools/meum-render-monitor/fixtures/business/payment-server.mjs'), /fixtures[\\/]business[\\/]payment-server\.mjs$/);
    assert.throws(() => productSourceRoot(), /MEUM_PRODUCT_ROOT/);
    assert.throws(() => reviewedSourceFile('.env'), /Unregistered/);
    process.env.MEUM_PRODUCT_ROOT = path.resolve('synthetic-product-source');
    assert.equal(reviewedSourceFile('8301_front-end/src/views/planSelect2.vue'), path.join(process.env.MEUM_PRODUCT_ROOT, '8301_front-end/src/views/planSelect2.vue'));
  } finally {
    if (previous === undefined) delete process.env.MEUM_PRODUCT_ROOT; else process.env.MEUM_PRODUCT_ROOT = previous;
  }
});
test('historical blocked business entries retain their registry roles instead of becoming false failures', () => {
  const report = publicSummary({ results: [], discovery: {} });
  const business = normalizedBusiness(report.businessVerification);
  assert.equal(business.cases.length, 11);
  assert.ok(business.cases.every(item => item.status === 'blocked'));
});
test('a network exception after a policy-blocked prerequisite is uncertain; an independent exception still fails', () => {
  for (const [message, expected] of [['Failed to fetch', 'unknown'], ['independent application defect', 'failure']]) {
    const target = { id: '1'.repeat(20), url: 'https://meum.me/meum-lite-viewer?r=synthetic' };
    const trace = createDiagnostics(target);
    const request = { url: () => 'https://backend.meum.me/api/rooms/getDataJson?room_id=1', method: () => 'GET', resourceType: () => 'fetch' };
    trace.block(request, 'known-mutating-read', 'scene-dto-migration');
    const diagnostics = trace.finish([{ kind: 'javascript', message }], { state: 'ready' }, {});
    assert.equal(diagnostics.groups.find(group => group.cause === 'javascript').severity, expected);
  }
});
