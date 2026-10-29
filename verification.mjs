export const verificationStatuses = ['pass', 'fail', 'blocked', 'unregistered', 'not-run'];

export function aggregateStatus(items, empty = 'unregistered') {
  const statuses = items.map(item => typeof item === 'string' ? item : item?.status).map(status => verificationStatuses.includes(status) ? status : 'not-run');
  if (!statuses.length) return empty;
  return ['fail', 'blocked', 'unregistered', 'not-run', 'pass'].find(status => statuses.includes(status));
}

export const legacyStatus = status => status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'unknown';

export function renderLayer(result) {
  let status = result.status === 'pass' || result.status === 'fail' ? result.status : 'not-run';
  if (status !== 'fail' && result.issues?.some(issue => ['access-required', 'runner', 'policy-block'].includes(issue.kind))) status = 'blocked';
  else if (result.issues?.some(issue => issue.kind === 'contract')) status = result.status === 'fail' ? 'fail' : 'unregistered';
  return { required: true, status, checkedAt: result.checkedAt, checks: result.checks || [], evidenceScope: 'public-readonly' };
}

export function withLayers(result, navigation) {
  const layers = {
    render: result.layers?.render || renderLayer(result),
    navigation: { required: true, status: 'unregistered', reason: '이 페이지의 기능/이동 계약이 등록되지 않았습니다.', ...navigation },
    business: { required: false, status: 'not-run', reason: '인증된 업무는 별도 격리 시나리오에서 검증합니다.' },
  };
  layers.navigation.required = true;
  const requiredCases = (Array.isArray(layers.navigation.cases) ? layers.navigation.cases : []).filter(item => item.required !== false);
  layers.navigation.status = aggregateStatus([layers.navigation.status, ...requiredCases]);
  if (layers.navigation.status === 'pass' && !requiredCases.length) {
    layers.navigation.status = 'unregistered';
    layers.navigation.reason = '필수 기능/이동 시나리오의 실행 근거가 없습니다.';
  }
  return { ...result, layers, status: legacyStatus(aggregateStatus(Object.values(layers).filter(layer => layer.required))) };
}

export function normalizeBusinessVerification(report) {
  const submitted = Array.isArray(report?.cases) ? report.cases : [];
  const registry = new Map(BUSINESS_CONTRACTS.map(item => [item.id, item]));
  const grouped = new Map();
  for (const item of submitted) { const rows = grouped.get(item?.id) || []; rows.push(item); grouped.set(item?.id, rows); }
  const missing = [], duplicates = [];
  const cases = BUSINESS_CONTRACTS.map(contract => {
    const rows = grouped.get(contract.id) || [];
    if (!rows.length) {
      missing.push(contract.id);
      return { id: contract.id, name: contract.name, role: contract.role, required: true, status: 'not-run', evidenceScope: 'blocked', reason: '등록된 필수 업무 시나리오의 실행 결과가 없습니다.', checks: [] };
    }
    let item = { ...rows[0], required: true };
    if (rows.length > 1) { duplicates.push(contract.id); return { ...item, status: 'fail', reason: '동일 업무 ID의 결과가 중복 제출됐습니다.' }; }
    if (item.role !== contract.role) return { ...item, status: 'fail', reason: '업무 계약의 역할과 실행 역할이 일치하지 않습니다.' };
    if (!verificationStatuses.includes(item.status)) item.status = 'not-run';
    if (item.status === 'pass' && item.evidenceScope !== 'isolated-app') item = { ...item, status: 'blocked', fixtureStatus: 'pass', reason: '모의 검증은 통과했으나 실제 격리 앱의 업무 결과는 미검증입니다.' };
    if (item.status === 'pass' && (!Number.isFinite(Date.parse(item.checkedAt)) || !Array.isArray(item.checks) || !item.checks.length || item.checks.some(check => check?.passed !== true))) item = { ...item, status: 'blocked', reason: '실제 업무 검증의 실행 시각 또는 결과 확인 증거가 부족합니다.' };
    return item;
  });
  const unregistered = [...grouped.keys()].filter(id => !registry.has(id));
  for (const id of unregistered) cases.push({ id: typeof id === 'string' ? id : 'missing-id', name: '미등록 업무 결과', role: 'unregistered', required: true, status: 'unregistered', evidenceScope: 'blocked', checks: [], reason: '등록되지 않았거나 ID가 없는 업무 결과입니다.' });
  const status = report?.status === 'fail' ? 'fail' : aggregateStatus(cases);
  return { ...(report || {}), required: true, cases, status, reason: report?.reason || '필수 업무 전체의 실제 검증 근거를 확인합니다.', coverage: { required: registry.size, missing, duplicates, unregistered } };
}

export function verificationSummary(results, business) {
  const tally = items => {
    const counts = Object.fromEntries(verificationStatuses.map(status => [status, 0]));
    for (const item of items) counts[verificationStatuses.includes(item?.status) ? item.status : 'not-run']++;
    return { ...counts, total: items.length, status: aggregateStatus(items) };
  };
  const renders = [], navigation = [], navigationLayers = [];
  for (const result of results) {
    const layers = withLayers(result, result.layers?.navigation).layers;
    renders.push(layers.render);
    navigationLayers.push(layers.navigation);
    const requiredCases = (layers.navigation.cases || []).filter(item => item.required !== false);
    navigation.push(...(requiredCases.length ? requiredCases : [layers.navigation]));
  }
  const businessResult = normalizeBusinessVerification(business);
  const summary = { render: tally(renders), navigation: tally(navigation), business: tally(businessResult.cases.length ? businessResult.cases : [businessResult]) };
  summary.navigation.status = aggregateStatus([summary.navigation, ...navigationLayers]);
  summary.business.status = aggregateStatus([summary.business, businessResult]);
  return { ...summary, status: aggregateStatus([summary.render, summary.navigation, summary.business]), checkedAt: new Date().toISOString() };
}
import { BUSINESS_CONTRACTS } from './business-contracts.mjs';
