import { aggregatePageStatus, BUSINESS_ROLE_REGISTRY, caseCapabilities, LAYER_KEYS, LAYER_LABELS, normalizedBusiness, normalizedLayer, verificationCounts } from './public/app.js';
import { normalizeBusinessVerification } from './verification.mjs';

const withheldCapture = '고객 정보 보호를 위해 공개 요약에 화면 캡처를 포함하지 않습니다. 상세 근거는 비공개 로컬 기록에서 확인하세요.';
const withheldUrl = '공개 요약에서는 고객·인증 페이지의 주소와 식별 정보를 숨깁니다.';
const statuses = new Set(['pass', 'fail', 'blocked', 'unregistered', 'not-run']);
const groups = new Set(['전시 프리뷰', '3D 관람', '아카이브', '제작자', '전시 상세', '공개 화면']);
const roles = new Set(['anonymous', 'visitor', 'guest', 'member', 'creator', 'owner', 'admin', 'super-admin', 'invited-admin', 'workspace-owner', 'workspace-admin', 'authenticated', 'read-only', 'eligible-creator', 'excluded-creator', 'payer']);
const modes = new Set(['read-only', 'readonly', 'fixture', 'synthetic', 'safe-fixture', 'observation', 'observe', 'navigation', 'business', 'write-fixture', 'disabled']);
const issueMessages = {
  javascript: '자바스크립트 실행 오류가 확인됐습니다.', 'browser-crash': '브라우저 탭이 종료됐습니다.', network: '필수 네트워크 요청이 실패했습니다.', 'http-resource': '필수 자산의 응답 오류가 확인됐습니다.', http: '페이지 응답 오류가 확인됐습니다.', redirect: '예상한 화면으로 이동하지 않았습니다.', 'render-timeout': '화면 준비 시간이 초과됐습니다.', 'required-content': '필수 화면 요소를 확인하지 못했습니다.', '3d-not-ready': '3D 엔진의 준비 완료를 확인하지 못했습니다.', loading: '로딩이 완료되지 않았습니다.', 'error-screen': '화면에 오류 상태가 표시됐습니다.', 'empty-dom': '본문이 비어 있습니다.', 'broken-image': '화면 이미지가 로드되지 않았습니다.', 'broken-background': '배경 이미지가 로드되지 않았습니다.', 'blank-screen': '빈 화면이 감지됐습니다.', 'blank-canvas': '3D 장면 표시를 확인하지 못했습니다.', 'access-required': '접근 조건이 충족되지 않아 관람 화면이 미확인입니다.', contract: '필수 검사 기준이 등록되지 않았습니다.', navigation: '화면 이동 검사가 실패했습니다.', 'entry-discovery': '실제 관람 목적지를 확인하지 못했습니다.', monitor: '이번 실행에서 새 점검 결과를 확인하지 못했습니다.', deployment: '배포 변경으로 새 점검이 필요합니다.',
};
const number = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, 1_000_000_000) : fallback;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const status = value => statuses.has(value) ? value : 'not-run';

function publicReason(value, required = true, legacy = false) {
  if (!required) return '공개 페이지에는 적용하지 않습니다. 인증된 업무는 별도 시나리오에서 점검합니다.';
  if (legacy) return '기존 보고서는 렌더링 전용입니다. 이동·업무 검증 기록은 등록되지 않았습니다.';
  const reasons = { pass: '등록된 확인 조건이 통과했습니다.', fail: '실행한 검사가 실패했습니다.', blocked: '실행에 필요한 인증·환경·격리된 앱 조건이 충족되지 않아 검사가 차단됐습니다.', unregistered: '이 단계의 검사 시나리오가 등록되지 않았습니다.', 'not-run': '이 단계의 검사를 실행한 기록이 없습니다.' };
  return (reasons[status(value)] || reasons['not-run']) + ' 상세 사유와 관측 원문은 비공개 로컬 기록에 보관합니다.';
}

function publicChecks(checks = []) {
  return checks.map((check, index) => ({ name: `확인 항목 ${index + 1}`, passed: typeof check.passed === 'boolean' ? check.passed : null }));
}

function publicViewport(value) {
  if (typeof value === 'string') return ['desktop', 'mobile', 'tablet'].includes(value) ? value : 'withheld';
  if (!value || typeof value !== 'object') return null;
  return { name: ['desktop', 'mobile', 'tablet'].includes(value.name) ? value.name : 'withheld', width: Math.min(number(value.width), 10000), height: Math.min(number(value.height), 10000) };
}

function publicLayer(layer, key) {
  return {
    required: layer.required, status: status(layer.status), checkedAt: date(layer.checkedAt),
    reason: publicReason(layer.status, layer.required, layer.legacy && key !== 'render'), detailsWithheld: true,
    checks: publicChecks(layer.checks),
    cases: layer.cases.map((item, index) => ({
      id: key === 'business' && Object.hasOwn(BUSINESS_ROLE_REGISTRY, item.id) ? item.id : `${key}-case-${index + 1}`, name: `${LAYER_LABELS[key]} 시나리오 ${index + 1}`, status: status(item.status), required: item.required,
      role: roles.has(item.role) ? item.role : 'withheld', mode: modes.has(item.mode) ? item.mode : 'withheld', viewport: publicViewport(item.viewport),
      reason: key === 'business' && item.status === 'blocked' && caseCapabilities(item).executorImplemented && !caseCapabilities(item).adapterImplemented ? '업무 실행 helper는 확인됐으나 UI·서버 연결 검증이 완료되지 않았습니다. 상세 차단 원문과 경로는 공개하지 않습니다.' : publicReason(item.status, item.required), checks: publicChecks(item.checks), checkedAt: date(item.checkedAt),
      evidenceScope: item.evidenceScope === 'isolated-app' ? 'isolated-app' : 'local-private', detailsWithheld: true,
      ...(key === 'business' ? { capabilities: caseCapabilities(item) } : {}),
    })),
  };
}

function publicWorkflowUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && /^\/[\w.-]+\/[\w.-]+\/actions(?:\/workflows\/[\w.-]+)?\/?$/.test(url.pathname) ? url.origin + url.pathname : '';
  } catch { return ''; }
}

export function publicSummary(source, ci = null, { workflowUrl = '', maxSiteBytes = 100 * 1024 * 1024, now = Date.now() } = {}) {
  if (!source || !Array.isArray(source.results)) throw new Error('점검 결과 JSON 형식이 올바르지 않습니다.');
  const results = source.results.map((result, index) => {
    const layers = Object.fromEntries(LAYER_KEYS.map(key => [key, publicLayer(normalizedLayer(result, key), key)]));
    const row = {
      id: `page-${index + 1}`, name: `페이지 점검 ${index + 1}`, group: groups.has(result.group) ? result.group : '페이지 점검',
      scope: !result.layers || result.scope === 'render-only' ? 'render-only' : 'layered',
      url: null, urlWithheldReason: withheldUrl, checkedAt: date(result.checkedAt), durationMs: number(result.durationMs),
      httpStatus: Number.isInteger(result.httpStatus) && result.httpStatus >= 100 && result.httpStatus <= 599 ? result.httpStatus : null,
      viewport: publicViewport(result.viewport), layers, screenshot: null, screenshotOmittedReason: withheldCapture, detailsWithheld: true,
      issues: (Array.isArray(result.issues) ? result.issues : []).slice(0, 30).map(issue => {
        const kind = Object.hasOwn(issueMessages, issue?.kind) ? issue.kind : 'withheld';
        return { kind, message: (issueMessages[kind] || '검사 관련 상세 기록이 있습니다.') + ' 원문·주소·요청값은 공개하지 않습니다.' };
      }),
    };
    row.status = aggregatePageStatus(row);
    row.checks = layers.render.checks;
    return row;
  });
  const businessVerification = publicLayer(normalizedBusiness(normalizeBusinessVerification(source.businessVerification)), 'business');
  businessVerification.checkedAt = date(source.businessVerification?.checkedAt || source.businessVerification?.completedAt);
  const intervalMinutes = number(source.intervalMinutes, 60) || 60;
  const ttl = Math.max(intervalMinutes * 2, 60) * 60000;
  const caseTimes = businessVerification.cases.filter(item => item.required).map(item => Date.parse(item.checkedAt));
  const globalTime = Date.parse(businessVerification.checkedAt);
  const fresh = time => Number.isFinite(time) && now - time <= ttl && time <= now + 300000;
  const allFresh = fresh(globalTime) && caseTimes.length === Object.keys(BUSINESS_ROLE_REGISTRY).length && caseTimes.every(fresh);
  if (businessVerification.status === 'pass' && !allFresh) {
    businessVerification.status = 'not-run';
    businessVerification.reason = '필수 업무 시나리오 중 최근 실행 시각을 확인하지 못한 결과가 있습니다. 새로운 점검이 필요합니다.';
    businessVerification.cases = businessVerification.cases.map(item => !fresh(globalTime) || !fresh(Date.parse(item.checkedAt)) ? { ...item, status: 'not-run', reason: '이 필수 업무 시나리오의 최근 실행 시각을 확인하지 못해 현재 통과로 표시하지 않습니다.' } : item);
  }
  const verification = verificationCounts(results, businessVerification);
  const businessPass = businessVerification.status === 'pass' && allFresh && verification.business.pass === verification.business.total;
  verification.status = results.some(row => row.status === 'fail') || businessVerification.status === 'fail' ? 'fail' : results.length && source.discovery?.complete === true && results.every(row => row.status === 'pass' && row.checkedAt && now - Date.parse(row.checkedAt) <= ttl) && businessPass ? 'pass' : 'unknown';
  const errors = Array.isArray(source.discovery?.errors) ? source.discovery.errors.length : 0;
  return {
    schemaVersion: 2, scope: 'required-layers', publicSummary: true, readOnly: true,
    runId: date(source.startedAt) ? `summary-${Date.parse(source.startedAt)}` : null,
    status: ['idle', 'running', 'completed', 'failed'].includes(source.status) ? source.status : 'failed',
    startedAt: date(source.startedAt), attemptStartedAt: date(source.attemptStartedAt), completedAt: date(source.completedAt), nextRunAt: null,
    intervalMinutes, exportedAt: new Date(now).toISOString(), workflowUrl: publicWorkflowUrl(workflowUrl),
    monitorMode: ci?.mode === 'continuous' ? 'continuous' : 'after-deploy', watchUntil: date(ci?.watchUntil),
    scheduleDescription: ci?.mode === 'continuous' ? 'GitHub Actions에서 매시간 브라우저 점검을 실행합니다. 예약 실행은 지연될 수 있습니다.' : 'GitHub Actions에서 매시간 확인하며, 배포 후 6시간 동안 브라우저를 실행합니다. 예약 실행은 지연될 수 있습니다.',
    discovery: { complete: source.discovery?.complete === true, source: '수집 경로의 상세 주소는 비공개입니다.', totalExhibitions: number(source.discovery?.totalExhibitions), totalTargets: Math.max(results.length, number(source.discovery?.totalTargets)), errors: Array.from({ length: Math.min(errors, 30) }, () => '공개 목록 또는 실행 준비 검사에서 오류가 확인됐습니다. 상세 정보는 비공개 기록에 보관합니다.') },
    results, businessVerification, verification,
    history: (Array.isArray(source.history) ? source.history : []).slice(-10).map((run, index) => ({ runId: `history-${index + 1}`, completedAt: date(run.completedAt), pass: number(run.pass), fail: number(run.fail), unknown: number(run.unknown), total: number(run.total), scope: run.scope === 'required-layers' ? 'required-layers' : 'render-only' })),
    evidence: { copiedScreenshots: 0, omittedScreenshots: source.results.filter(row => row.screenshot).length, normalScreenshotLimit: 0, maxSiteBytes, policy: 'public-summary-only', detailsWithheld: true, reason: withheldCapture },
    privacy: { policy: 'allowlist', captures: 'withheld', rawUrls: 'withheld', identities: 'withheld', requestValues: 'withheld', observerObjects: 'withheld' },
  };
}
