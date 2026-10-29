import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateStatus, withLayers, verificationSummary, normalizeBusinessVerification } from '../verification.mjs';
import { BUSINESS_CONTRACTS } from '../business-contracts.mjs';
const fullBusiness = () => ({ checkedAt: new Date().toISOString(), cases: BUSINESS_CONTRACTS.map(({ id, role }) => ({ id, role, status: 'pass', evidenceScope: 'isolated-app', checkedAt: new Date().toISOString(), checks: [{ name: 'Independent readback', passed: true }] })) });

test('unregistered, unexecuted and blocked checks cannot pass a layer', () => {
  assert.equal(aggregateStatus([]), 'unregistered');
  for (const status of ['blocked', 'unregistered', 'not-run', undefined]) assert.notEqual(aggregateStatus([{ status: 'pass' }, { status }]), 'pass');
  assert.equal(aggregateStatus([{ status: 'blocked' }, { status: 'fail' }]), 'fail');
});

test('a legacy render pass is not a functional pass', () => {
  const row = withLayers({ status: 'pass', checks: [{ name: 'DOM', passed: true }] });
  assert.equal(row.layers.render.status, 'pass');
  assert.equal(row.layers.navigation.status, 'unregistered');
  assert.equal(row.layers.business.required, false);
  assert.equal(row.status, 'unknown');
});

test('public navigation may pass without claiming authenticated business passed', () => {
  const row = withLayers({ status: 'pass' }, { status: 'pass', cases: [{ status: 'pass' }] });
  assert.equal(row.status, 'pass');
  const report = verificationSummary([row], { cases: fullBusiness().cases.map(item => ({ ...item, status: 'blocked', evidenceScope: 'blocked' })) });
  assert.equal(report.render.pass, 1);
  assert.equal(report.navigation.pass, 1);
  assert.notEqual(report.business.status, 'pass');
  assert.equal(report.business.pass, 0);
  assert.equal(report.status, 'blocked');
});

test('a successful synthetic business harness is not an actual app business pass', () => {
  const input = fullBusiness(); input.cases[0].evidenceScope = 'fixture';
  const report = normalizeBusinessVerification(input);
  assert.equal(report.status, 'blocked');
  assert.equal(report.cases[0].fixtureStatus, 'pass');
  assert.equal(normalizeBusinessVerification(fullBusiness()).status, 'pass');
});

test('business pass requires all11 unique registered cases, matching roles and result evidence', () => {
  assert.equal(BUSINESS_CONTRACTS.length, 11);
  const missing = fullBusiness(); missing.cases.pop();
  const partial = normalizeBusinessVerification(missing);
  assert.notEqual(partial.status, 'pass');
  assert.equal(partial.coverage.missing.length, 1);
  assert.equal(partial.cases.find(item => item.id === partial.coverage.missing[0]).status, 'not-run');
  const duplicate = fullBusiness(); duplicate.cases.push(duplicate.cases[0]);
  assert.equal(normalizeBusinessVerification(duplicate).status, 'fail');
  assert.equal(normalizeBusinessVerification({ cases: [{ status: 'pass', evidenceScope: 'isolated-app' }] }).status, 'unregistered');
  const unknown = fullBusiness(); unknown.cases.push({ id: 'unknown', status: 'pass', evidenceScope: 'isolated-app' });
  assert.equal(normalizeBusinessVerification(unknown).status, 'unregistered');
  const role = fullBusiness(); role.cases[1].role = 'owner';
  assert.equal(normalizeBusinessVerification(role).status, 'fail');
  const noReadback = fullBusiness(); noReadback.cases[0].checks = [];
  assert.equal(normalizeBusinessVerification(noReadback).status, 'blocked');
});

test('a business runner error cannot be hidden by otherwise successful cases', () => {
  const report = fullBusiness(); report.status = 'fail';
  assert.equal(verificationSummary([], report).business.status, 'fail');
});

test('every required public function participates in page verdict', () => {
  const row = withLayers({ status: 'pass' }, { status: 'blocked', cases: [{ status: 'pass' }, { status: 'blocked' }] });
  assert.equal(row.status, 'unknown');
  assert.equal(row.layers.render.status, 'pass');
  const summary = verificationSummary([row]);
  assert.equal(summary.navigation.total, 2);
  assert.equal(summary.navigation.blocked, 1);
});

test('an empty navigation result and an explicit runner failure cannot become green', () => {
  for (const cases of [undefined, [], [{ status: 'pass', required: false }]]) {
    const row = withLayers({ status: 'pass' }, { status: 'pass', cases });
    assert.equal(row.layers.navigation.status, 'unregistered');
    assert.equal(row.status, 'unknown');
  }
  for (const status of ['fail', 'blocked', 'unregistered', 'not-run']) {
    const row = withLayers({ status: 'pass' }, { status, cases: [{ status: 'pass' }] });
    assert.equal(row.layers.navigation.status, status);
    assert.equal(verificationSummary([row]).navigation.status, status);
  }
});

test('inapplicable public cases are excluded from required navigation counts', () => {
  const row = withLayers({ status: 'pass' }, { status: 'pass', cases: [{ status: 'pass' }, { status: 'not-run', required: false }] });
  const summary = verificationSummary([row]);
  assert.equal(summary.navigation.status, 'pass');
  assert.equal(summary.navigation.total, 1);
  assert.equal(summary.navigation['not-run'], 0);
});
