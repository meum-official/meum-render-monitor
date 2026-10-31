export const LAYER_KEYS = ['render', 'navigation', 'business'];
export const LAYER_LABELS = { render: '화면 렌더링', navigation: '화면 이동', business: '인증된 업무' };
export const LAYER_STATUS_LABELS = { pass: '통과', fail: '실패', blocked: '차단', unregistered: '미등록', 'not-run': '미실행' };
export const CAPABILITY_LABELS = { contractRegistered: '계약 등록', executorImplemented: '실행 helper', adapterImplemented: 'UI·서버 연결 검증', fixtureValidated: 'fixture 검증', actualAppAdapterImplemented: '실제 앱 연결 구현', actualAppValidated: '실제 앱 검증' };
export function caseCapabilities(item) {
  return Object.fromEntries(Object.keys(CAPABILITY_LABELS).map(key => [key, typeof item?.capabilities?.[key] === 'boolean' ? item.capabilities[key] : typeof item?.[key] === 'boolean' ? item[key] : false]));
}
// Browser copy of the reviewed registry; the report tests enforce ID/role parity.
export const BUSINESS_ROLE_REGISTRY = {
  'viewer-settings-owner': 'owner', 'viewer-settings-invited-admin': 'invited-admin', 'viewer-settings-readonly': 'read-only',
  'auto-install': 'owner', 'survey-target-included': 'eligible-creator', 'survey-target-excluded': 'excluded-creator',
  'survey-submit-admin-read': 'eligible-creator', 'payment-success-immediate': 'payer', 'payment-success-scheduled': 'payer',
  'payment-failure-cancel': 'payer', 'payment-duplicate-callback': 'payer',
};
const layerStatus = value => Object.hasOwn(LAYER_STATUS_LABELS, value) ? value : 'not-run';
const combineStatuses = values => ['fail', 'blocked', 'unregistered', 'not-run'].find(status => values.includes(status)) || (values.length ? 'pass' : 'unregistered');

export function normalizedLayer(result, key) {
  if (result.renderOnly && key !== 'render') return { required: false, status: 'not-run', cases: [], reason: '대상 아님: 렌더링 전용 검사' };
  const source = result.layers?.[key];
  const legacy = !result.layers;
  const required = key === 'render' || source?.required !== false;
  const cases = Array.isArray(source?.cases) ? source.cases.map(item => ({
    id: item.id, name: item.name, status: key === 'business' && item.status === 'pass' && item.evidenceScope !== 'isolated-app' ? 'blocked' : layerStatus(item.status), required: item.required !== false,
    role: item.role, mode: item.mode, viewport: item.viewport, reason: key === 'business' && item.status === 'pass' && item.evidenceScope !== 'isolated-app' ? '격리된 실제 앱에서의 업무 검증 근거가 없습니다. 구성요소·픽스처 검사는 업무 통과로 집계하지 않습니다.' : item.reason,
    checks: Array.isArray(item.checks) ? item.checks : [], checkedAt: item.checkedAt,
    evidenceScope: item.evidenceScope,
    ...(key === 'business' ? { capabilities: caseCapabilities(item), adapterBlocker: typeof item.capabilities?.adapterBlocker === 'string' ? item.capabilities.adapterBlocker : typeof item.adapterBlocker === 'string' ? item.adapterBlocker : null } : {}),
  })) : [];
  let status = source ? layerStatus(source.status) : legacy && key === 'render' ? layerStatus(result.status) : 'unregistered';
  const requiredCases = cases.filter(item => item.required);
  if (requiredCases.length) status = combineStatuses([status, ...requiredCases.map(item => item.status)]);
  else if (source && key !== 'render' && required && status === 'pass') status = 'unregistered';
  const reason = source?.reason || (legacy && key !== 'render' ? '기존 보고서는 화면 렌더링만 확인했습니다. 이 단계의 시나리오는 등록되지 않았습니다.' : !required ? '이 페이지에서는 적용하지 않습니다. 별도 시나리오에서 점검합니다.' : status === 'unregistered' ? '이 단계의 검사 시나리오가 등록되지 않았습니다.' : status === 'not-run' ? '이 단계의 검사 실행 기록이 없습니다.' : '');
  return { status, required, reason, cases, legacy, checkedAt: source?.checkedAt, checks: Array.isArray(source?.checks) ? source.checks : key === 'render' && Array.isArray(result.checks) ? result.checks : [] };
}

export function normalizedBusiness(source) {
  if (source?.required === false && source?.cases?.length === 0) return { required: false, status: 'not-run', cases: [], reason: '대상 아님: 렌더링 전용 검사' };
  const supplied = Array.isArray(source?.cases) ? source.cases : [];
  const unknown = supplied.some(item => !Object.hasOwn(BUSINESS_ROLE_REGISTRY, item?.id));
  const invalid = source?.cases !== undefined && !Array.isArray(source.cases);
  const cases = Object.entries(BUSINESS_ROLE_REGISTRY).map(([id, role]) => {
    const found = supplied.filter(item => item?.id === id);
    if (!found.length) return { id, name: id, role, required: true, status: 'not-run', reason: '등록된 필수 업무 시나리오의 실행 결과가 없습니다.', checks: [] };
    if (found.length > 1) return { id, name: id, role, required: true, status: 'fail', reason: '같은 필수 업무 시나리오의 결과가 중복되어 검증할 수 없습니다.', checks: [] };
    const item = found[0];
    if (item.role !== role) return { ...item, required: true, status: 'fail', reason: '등록된 업무 역할과 실행 역할이 일치하지 않습니다.' };
    if (item.status === 'pass' && (!Number.isFinite(Date.parse(item.checkedAt)) || !Array.isArray(item.checks) || !item.checks.length || item.checks.some(check => check?.passed !== true))) return { ...item, required: true, status: 'blocked', reason: '필수 업무 검사의 실행 시각과 통과한 확인 항목의 근거가 충분하지 않습니다.' };
    return { ...item, required: true };
  });
  const status = invalid ? 'fail' : combineStatuses([...cases.map(item => layerStatus(item.status)), ...(unknown ? ['unregistered'] : []), ...(source?.status ? [layerStatus(source.status)] : [])]);
  return normalizedLayer({ layers: { business: { ...source, required: true, status, cases, reason: unknown || invalid ? '등록되지 않은 업무 ID 또는 잘못된 결과 형식이 있어 검증할 수 없습니다.' : source?.reason || (!source ? '등록된 필수 업무 시나리오를 아직 실행하지 않았습니다.' : '') } } }, 'business');
}

export function aggregatePageStatus(result) {
  const statuses = LAYER_KEYS.map(key => normalizedLayer(result, key)).filter(layer => layer.required).map(layer => layer.status);
  return statuses.includes('fail') ? 'fail' : statuses.every(status => status === 'pass') ? 'pass' : 'unknown';
}

export function verificationCounts(results, businessVerification) {
  const summary = Object.fromEntries(LAYER_KEYS.map(key => [key, { pass: 0, fail: 0, blocked: 0, unregistered: 0, 'not-run': 0, total: 0, excluded: 0 }]));
  const add = (key, layer, cases = false) => {
    if (!layer.required) { summary[key].excluded++; return; }
    const units = cases && layer.cases.some(item => item.required) ? layer.cases.filter(item => item.required) : [layer];
    if (units[0] !== layer && layer.status !== combineStatuses(units.map(item => item.status))) units.push({ status: layer.status });
    for (const unit of units) { summary[key][layerStatus(unit.status)]++; summary[key].total++; }
  };
  for (const result of results) for (const key of LAYER_KEYS) add(key, normalizedLayer(result, key), key === 'business');
  add('business', normalizedBusiness(businessVerification), true);
  return summary;
}

if (typeof document !== 'undefined') (() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const labels = { pass: '정상', fail: '문제 발견', unknown: '미확인', pending: '점검 대기' };
  const dateFormat = new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  let state = null;
  let connected = false;
  let filter = 'all';
  let fetching = false;
  let requestingRun = false;
  let lastFetchAt = 0;
  const openRequestLogs = new Set();
  const causeLabels = { 'http-resource': 'HTTP 리소스 오류', network: '네트워크 실패', 'policy-block': '읽기 전용 정책 차단', readiness: '화면 준비 미완료', navigation: '페이지 이동 실패', javascript: '자바스크립트 실행 오류', render: '화면·픽셀 이상', 'unclassified-resource': '리소스 역할 미분류' };
  const severityLabels = { failure: '실패', warning: '주의', blocked: '차단', unknown: '미확인' };
  const blockedLabels = { 'mutating-method': '쓰기 메서드 차단', 'known-mutating-read': '부작용이 있는 GET/HEAD 차단', 'websocket-disabled': 'WebSocket 차단', 'entry-navigation-not-executed': '관람 이동 미실행', 'network-failed': '네트워크 실패', pending: '응답 미확인' };
  const policyLabels = { 'aggregate-counter-repair': '집계 값 복구', 'exhibition-auto-close': '종료 전시 자동 변경', 'page-view-count': '페이지 방문 집계', 'viewer-visit-and-migration': '관람 방문 집계·데이터 이관', 'comment-default-create': '댓글 기본값 생성', 'scene-dto-migration': '장면 데이터 이관', 'invitation-default-create': '초대장 기본값 생성', 'rose-claim-and-capability': '선물 수령 처리·소켓 권한 발급', 'password-attempt-state': '비밀번호 시도 상태 변경', 'socket-capability': '소켓 권한 발급', 'board-view-count': '게시물 조회 집계', 'invalid-url': '유효하지 않은 주소', 'mutating-method': '쓰기 메서드', 'websocket-disabled': 'WebSocket 비활성', 'entry-navigation-not-executed': '관람 이동 미실행' };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function formatDate(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? dateFormat.format(date) : '아직 점검하지 않음';
  }
  function isStale(result) {
    const checked = new Date(result.checkedAt || NaN).getTime();
    const ttl = Math.max(2 * (Number(state?.intervalMinutes) || 0), 60) * 60_000;
    return !connected || !Number.isFinite(checked) || Date.now() - checked > ttl;
  }
  function statusOf(result) {
    return isStale(result) ? 'unknown' : (state.sampling || state.discovery?.sampling) ? (['pass', 'fail'].includes(result.status) ? result.status : 'unknown') : aggregatePageStatus(result);
  }
  function displayedLayer(result, key) {
    const layer = normalizedLayer(result, key);
    if (layer.required && ['pass', 'fail'].includes(layer.status) && isStale(result)) return { ...layer, status: 'not-run', reason: connected ? '결과가 오래되어 새 점검이 필요합니다.' : '서버 연결이 끊겨 현재 결과를 확인할 수 없습니다.', cases: layer.cases.map(item => ({ ...item, status: 'not-run' })) };
    return layer;
  }
  function displayedBusiness() {
    const layer = normalizedBusiness(state.businessVerification);
    const source = state.businessVerification || {};
    const caseTimes = layer.cases.filter(item => item.required).map(item => Date.parse(item.checkedAt));
    const globalTime = Date.parse(source.checkedAt || source.completedAt);
    const valid = Number.isFinite(globalTime) && caseTimes.length === Object.keys(BUSINESS_ROLE_REGISTRY).length && caseTimes.every(Number.isFinite);
    const checkedAt = valid ? new Date(Math.min(globalTime, ...caseTimes)).toISOString() : null;
    const ttl = Math.max(2 * (Number(state.intervalMinutes) || 0), 60) * 60_000;
    if (layer.status === 'pass' && (!checkedAt || isStale({ checkedAt }) || Math.max(globalTime, ...caseTimes) > Date.now() + 300000)) return { ...layer, status: 'not-run', reason: '필수 업무 시나리오 중 최근 실행 시각을 확인하지 못한 결과가 있습니다.', cases: layer.cases.map(item => ({ ...item, ...(!connected || !Number.isFinite(globalTime) || Date.now() - globalTime > ttl || !Number.isFinite(Date.parse(item.checkedAt)) || Date.now() - Date.parse(item.checkedAt) > ttl || Date.parse(item.checkedAt) > Date.now() + 300000 ? { status: 'not-run' } : {}) })) };
    return layer;
  }
  function layerBadge(layer, prefix = '') {
    const style = layer.status === 'pass' && layer.required ? 'pass' : layer.status === 'fail' && layer.required ? 'fail' : 'unknown';
    const badge = el('span', 'layer-badge ' + style);
    badge.append(el('span', 'dot dot-' + (style === 'pass' ? 'green' : style === 'fail' ? 'red' : 'gray')), document.createTextNode(prefix + (layer.required ? LAYER_STATUS_LABELS[layer.status] : state.renderOnly ? '대상 아님' : '별도 검사')));
    return badge;
  }
  function renderLayerSummaries(results) {
    const adjusted = results.map(result => ({ ...result, layers: Object.fromEntries(LAYER_KEYS.map(key => [key, displayedLayer(result, key)])) }));
    const business = displayedBusiness();
    if ($('business-scope-title')) {
      const outOfScope = state.renderOnly || business.required === false;
      const blocked = business.cases.filter(item => ['blocked', 'not-run'].includes(item.status)).length;
      $('business-scope-title').textContent = outOfScope ? '기능·인증 업무 · 대상 아님' : `실제 앱 업무 ${business.cases.length}개 · ${blocked === business.cases.length ? '모두 차단 / 미실행' : '별도 검증 결과'}`;
      $('business-scope-note').textContent = outOfScope ? '생성·수정·초대·결제·비밀번호·프로필 변경과 메뉴 여정을 실행하거나 통과로 집계하지 않습니다. 로그인 화면 표시는 인증 성공을 뜻하지 않습니다.' : '이전 보고서의 별도 업무 검증 상태입니다. 렌더링 통과와 구분합니다.';
    }
    const summary = verificationCounts(adjusted, business);
    const cards = LAYER_KEYS.map(key => {
      const info = summary[key];
      const card = el('article', 'layer-card panel');
      const top = el('div', 'layer-card-heading');
      const allPass = info.total > 0 && info.pass === info.total;
      const currentStatus = ['fail', 'blocked', 'unregistered', 'not-run'].find(status => info[status] > 0) || (allPass ? 'pass' : 'unregistered');
      const excluded = state.renderOnly && key !== 'render';
      top.append(el('h3', '', LAYER_LABELS[key]), excluded ? el('span', 'muted', '대상 아님') : layerBadge({ status: currentStatus, required: true }));
      card.append(top, el('p', 'layer-card-total', excluded ? '집계 제외 · 실행하지 않음' : `${info.pass} / ${info.total} 통과`));
      const counts = el('div', 'layer-counts');
      for (const [status, label] of Object.entries(LAYER_STATUS_LABELS)) counts.append(el('span', status === 'fail' && info[status] ? 'text-fail' : '', `${label} ${info[status]}`));
      if (!excluded) card.append(counts);
      const note = excluded ? '대상 아님: 렌더링 전용 검사에서는 실행하거나 통과로 집계하지 않습니다.' : key === 'business' ? business.reason || '인증된 업무 시나리오를 별도로 확인합니다.' : key === 'navigation' ? '등록된 이동 시나리오가 통과해야 페이지의 필수 검사 통과로 표시합니다.' : '본문·실행 오류·렌더링 준비 조건을 확인합니다.';
      card.append(el('p', 'layer-card-note', note));
      if (info.excluded && !excluded) card.append(el('p', 'layer-card-note', `이 단계 적용 제외 ${info.excluded}개는 통과로 집계하지 않습니다.`));
      if (key === 'business' && business.cases.length) {
        const cases = el('details', 'global-cases');
        cases.append(el('summary', '', `업무 시나리오 ${business.cases.length}개와 실행 사유`), caseList(business.cases));
        card.append(cases);
      }
      return card;
    });
    $('layer-summaries').replaceChildren(...cards);
    return { summary, business };
  }
  function safeLink(value, screenshot = false) {
    try {
      if (typeof value !== 'string' || !value) return null;
      const url = new URL(screenshot && String(value).startsWith('/screenshots/') ? String(value).slice(1) : value, document.baseURI);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
      if (screenshot && (url.origin !== window.location.origin || !url.pathname.startsWith(new URL('screenshots/', document.baseURI).pathname))) return null;
      return url.href;
    } catch { return null; }
  }
  function makeLink(value, label, className, screenshot = false) {
    const url = safeLink(value, screenshot);
    const node = el(url ? 'a' : 'span', className, label);
    if (url) { node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
    return node;
  }
  function issueMessage(issue) {
    return typeof issue === 'string' ? issue : String(issue?.message || issue?.kind || '알 수 없는 오류');
  }
  function formatUtc(value) {
    return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC') : '시각 미확인';
  }
  function renderDiagnostics(result) {
    const section = el('section', 'diagnostics');
    section.setAttribute('aria-label', '원인별 요청 진단');
    section.append(el('p', 'detail-label', '원인별 요청 진단'));
    const diagnostic = result.diagnostics;
    if (diagnostic?.schemaVersion !== 1) {
      section.append(el('p', 'muted', '이전 결과에는 요청별 진단이 없습니다. 새 점검에서 UTC 시각·HTTP 상태·차단 사유를 수집합니다.'));
      return section;
    }
    const groups = Array.isArray(diagnostic.groups) ? diagnostic.groups : [];
    if (diagnostic.primaryCause && causeLabels[diagnostic.primaryCause]) section.append(el('p', 'diagnostic-primary', `주요 원인 · ${causeLabels[diagnostic.primaryCause]}`));
    if (groups.length) {
      const list = el('ul', 'diagnostic-groups');
      for (const group of groups) {
        const severity = Object.hasOwn(severityLabels, group.severity) ? group.severity : 'unknown';
        const item = el('li', 'diagnostic-group ' + severity);
        item.append(el('span', 'diagnostic-severity', severityLabels[severity]), el('span', '', `${causeLabels[group.cause] || '분류 확인 필요'} · ${Number.isSafeInteger(group.count) ? group.count : 0}건`));
        if (group.cause === 'readiness') item.append(el('span', 'muted', '시간 초과·Unity 전역값·로딩·필수 요소를 한 원인으로 묶었습니다.'));
        if (Array.isArray(group.requestIds) && group.requestIds.length) item.append(el('span', 'diagnostic-ids', group.requestIds.slice(0, 6).join(', ') + (group.requestIds.length > 6 ? ` 외 ${group.requestIds.length - 6}건` : '')));
        list.append(item);
      }
      section.append(list);
    } else section.append(el('p', 'muted', '이 실행에서 분류된 진단 원인이 없습니다.'));
    const readiness = diagnostic.readiness;
    if (readiness) {
      const readinessLabels = { ready: '준비 확인', failed: '준비 실패', blocked: '정책으로 미확인', unverified: '미확인' };
      const milliseconds = value => Number.isFinite(value) && value >= 0 ? `${(value / 1000).toFixed(1)}초` : '미확인';
      section.append(el('p', 'diagnostic-readiness', `화면 준비: ${readinessLabels[readiness.state] || '미확인'} · 전역값 ${readiness.requiredGlobal || '없음'} · 필수 요소 ${Array.isArray(readiness.selectors) ? readiness.selectors.length : 0}개 · 로딩 조건 ${Array.isArray(readiness.loading) ? readiness.loading.length : 0}개 · 경과 ${milliseconds(readiness.elapsedMs)} / 준비 제한 ${milliseconds(diagnostic.timeouts?.readinessMs)} · 이동 제한 ${milliseconds(diagnostic.timeouts?.navigationMs)}`));
      if (readiness.observed) {
        const observed = readiness.observed;
        const conditions = el('ul', 'diagnostic-conditions');
        for (const selector of readiness.selectors || []) conditions.append(el('li', '', `${selector} · ${(observed.missingSelectors || []).includes(selector) ? '미확인' : '확인'}`));
        for (const selector of readiness.loading || []) conditions.append(el('li', '', `${selector} · ${(observed.visibleLoading || []).includes(selector) ? '로딩 표시 중' : '로딩 표시 없음'}`));
        if (readiness.requiredGlobal) conditions.append(el('li', '', `${readiness.requiredGlobal} · ${observed.globalReady === true ? '확인' : '미확인'}`));
        section.append(conditions);
      }
    }
    const requests = Array.isArray(diagnostic.requests) ? diagnostic.requests : [];
    const details = el('details', 'request-log');
    details.open = openRequestLogs.has(result.id);
    const omitted = Number.isSafeInteger(diagnostic.droppedRequests) && diagnostic.droppedRequests > 0 ? ` · 한도 초과 ${diagnostic.droppedRequests}건 미기록` : '';
    details.append(el('summary', '', `요청 기록 ${requests.length}건 · UTC${omitted}`));
    let rendered = false;
    const fill = () => {
      if (!details.open || rendered) return;
      rendered = true;
      const wrapper = el('div', 'request-table-wrap');
      const table = el('table', 'request-table');
      const caption = el('caption', 'sr-only', '요청 순서, 요청 ID, UTC 시작·완료 시각, 메서드, 리소스 종류, 마스킹된 출처·경로, HTTP 상태 또는 차단 사유');
      const head = el('thead'); const headings = el('tr');
      for (const name of ['순서 · 요청 ID', '요청 시각 (UTC)', '메서드 · 종류', '출처 · 마스킹된 경로', 'HTTP · 차단 사유']) headings.append(el('th', '', name));
      head.append(headings); const body = el('tbody');
      for (const request of requests) {
        const row = el('tr');
        const id = el('td'); id.append(el('span', '', `#${request.seq}`), el('code', '', request.requestId));
        const at = el('td'); at.append(el('time', '', formatUtc(request.at)));
        if (request.responseAt) at.append(el('span', 'request-completed', '응답 ' + formatUtc(request.responseAt)));
        if (request.completedAt) at.append(el('span', 'request-completed', '완료 ' + formatUtc(request.completedAt)));
        const method = el('td'); method.append(el('strong', '', request.method || '미확인'), el('span', '', `${request.resourceType || '미확인'} · ${{ essential: '필수', optional: '선택', unknown: '역할 미분류' }[request.role] || '역할 미분류'}`));
        const location = el('td'); location.append(el('span', 'request-origin', request.origin || '출처 미확인'), el('code', 'request-path', request.path || '경로 비공개'));
        const outcome = el('td', Number.isSafeInteger(request.status) && request.status >= 400 ? 'request-http-error' : '');
        outcome.append(el('strong', '', Number.isSafeInteger(request.status) ? `HTTP ${request.status}` : 'HTTP 상태 없음'));
        if (blockedLabels[request.blockedReason]) outcome.append(el('span', '', blockedLabels[request.blockedReason]));
        if (policyLabels[request.policyCode]) outcome.append(el('span', '', policyLabels[request.policyCode]));
        if (request.contract) outcome.append(el('span', 'muted', request.contract));
        row.append(id, at, method, location, outcome); body.append(row);
      }
      table.append(caption, head, body); wrapper.append(table); details.append(wrapper);
      if (!requests.length) details.append(el('p', 'muted', '저장된 요청 기록이 없습니다. 요청이 성공했다는 뜻은 아닙니다.'));
    };
    details.addEventListener('toggle', () => { if (details.open) openRequestLogs.add(result.id); else openRequestLogs.delete(result.id); fill(); });
    fill(); section.append(details);
    return section;
  }
  function renderOverview(results) {
    const counts = { pass: 0, fail: 0, unknown: 0 };
    for (const row of results) counts[statusOf(row)] += 1;
    const total = Math.max(results.length, Number(state.discovery?.totalTargets) || 0);
    counts.unknown += total - results.length;
    if ($('version-meta')) { const v = state.versions || {}; $('version-meta').textContent = `모니터 ${v.monitorRevision || 'unknown'} · 명세 ${v.contractHash || 'unknown'} · 제품 소스 ${v.sourceRevision || 'unknown'} · 운영 배포 ${v.deployedRevision || 'unknown'} · 버전 대조 ${v.comparison || 'unknown'}`; }
    $('total-count').textContent = total.toLocaleString('ko-KR');
    for (const key of ['pass', 'fail', 'unknown']) $(key + '-count').textContent = counts[key].toLocaleString('ko-KR');
    const running = state.status === 'running';
    const sampling = state.sampling || state.discovery?.sampling;
    const sampled = state.renderOnly || sampling?.mode === 'representative-sample';
    const complete = state.discovery?.complete === true && (!sampled || /^[a-f0-9]{20}$/.test(sampling.selectionId || ''));
    const { summary: verification, business } = renderLayerSummaries(results);
    const businessPass = business.status === 'pass' && verification.business.total > 0 && verification.business.pass === verification.business.total;
    let kind = 'unknown';
    let title = '아직 확인되지 않은 페이지가 있습니다';
    let description = '대기 중이거나 오래된 결과는 정상으로 표시하지 않습니다.';
    if (!connected) { title = '점검 서버에 연결할 수 없습니다'; description = '표시된 이전 결과의 현재 상태를 확인할 수 없습니다.'; }
    else if (sampled) {
      if (counts.fail) { kind = 'fail'; title = `${counts.fail.toLocaleString('ko-KR')}개 표본에서 렌더링 문제가 발견됐습니다`; description = '아래 빨간 표시의 공개 표본에서 검사 근거를 확인하세요.'; }
    else if (running) { kind = 'running'; title = '공개 대표 표본을 점검하고 있습니다'; description = '선택된 공개 경로를 실제 브라우저에서 순서대로 열어 확인합니다.'; }
    else if (state.status === 'failed') { title = '이번 표본 점검을 완료하지 못했습니다'; description = '수집 및 실행 오류를 확인하세요. 미확인 페이지는 정상으로 표시하지 않습니다.'; }
    else if (total > 0 && !counts.unknown && complete) { kind = 'pass'; title = '이번 공개 표본의 렌더링 검사 통과'; description = `${total.toLocaleString('ko-KR')}개 표본 경로가 화면 검사 기준을 통과했습니다. 실제 업무 동작은 미검증입니다.`; }
    else if (!complete && state.startedAt) { title = '대표 표본 선택·수집을 확인해 주세요'; description = '선택 메타 또는 표본 수집이 완전하지 않아 이번 범위의 확인이 필요합니다.'; }
    } else {
      if (counts.fail || verification.business.fail) { kind = 'fail'; title = '필수 검사에서 문제가 발견됐습니다'; description = `공개 페이지 ${counts.fail}개 · 업무 검사 ${verification.business.fail}개 실패. 단계별 근거를 확인하세요.`; }
    else if (running) { kind = 'running'; title = '공개 페이지를 점검하고 있습니다'; description = '페이지를 실제 브라우저에서 순서대로 열고 렌더링 결과를 확인합니다.'; }
    else if (state.status === 'failed') { title = '전체 점검을 완료하지 못했습니다'; description = '수집 및 실행 오류를 확인하세요. 미확인 페이지는 정상으로 표시하지 않습니다.'; }
    else if (total > 0 && !counts.unknown && complete && businessPass) { kind = 'pass'; title = '공개 브라우저 검사와 등록 업무 검사가 통과했습니다'; description = `${total.toLocaleString('ko-KR')}개 페이지의 필수 단계와 등록된 업무 시나리오가 설정된 기준을 통과했습니다.`; }
    else if (total > 0 && !counts.unknown && complete) { title = '공개 화면·이동 검사 통과 · 업무 검증 미완료'; description = '업무 단계의 차단·미등록·미실행 사유를 확인하세요. 공개 브라우저 결과만으로 전체 기능을 정상 판정하지 않습니다.'; }
    else if (results.some(result => !result.layers || result.scope === 'render-only')) { title = '기존 보고서는 렌더링 결과만 확인됐습니다'; description = '화면 이동과 인증된 업무는 미등록 상태이며 필수 단계 통과로 집계하지 않습니다.'; }
    else if (!complete && state.startedAt) { title = '공개 페이지 목록 수집을 확인해 주세요'; description = '목록이 완전하지 않아 서비스 전체가 정상이라고 판단할 수 없습니다.'; }
    }
    if (!total && connected && !running && state.status !== 'failed') { title = '첫 점검을 기다리고 있습니다'; description = '실제 검사 결과가 들어오면 페이지별 상태를 표시합니다.'; }
    $('overview-title').textContent = title;
    $('overview-description').textContent = description;
    $('overview-beacon').className = 'beacon ' + kind;
    $('completed-at').textContent = formatDate(state.completedAt);
    $('next-run').textContent = running ? '현재 점검 중' : state.nextRunAt ? formatDate(state.nextRunAt) : state.scheduleDescription || (state.mode === 'after-deploy' ? '배포 변경 감시 중' : '수동 실행');
    $('run-button').disabled = running || requestingRun || !connected || (state.readOnly && !safeLink(state.workflowUrl));
    $('run-button').replaceChildren(el('span', '', '↻'), document.createTextNode(state.readOnly ? ' GitHub에서 표본 점검 ↗' : running ? ' 표본 점검 중' : ' 지금 표본 점검'));
    document.querySelector('.refresh-label').replaceChildren(el('span', 'dot dot-blue'), document.createTextNode(state.readOnly ? ' 1분마다 갱신' : ' 5초마다 갱신'));
    if (state.watcherError) $('action-message').textContent = '배포 변경 감시 오류: ' + state.watcherError;
    const checked = results.filter((row) => row.checkedAt && row.status !== 'pending').length;
    const percent = total ? Math.min(100, Math.round(checked / total * 100)) : 0;
    $('progress-bar').style.width = percent + '%';
    $('progress-label').textContent = `렌더링 실행 기록 ${checked.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')} 페이지${running ? ' · 점검 중' : ''}`;
    $('progress-percent').textContent = percent + '%';
    const badge = $('coverage-badge');
    badge.textContent = !connected ? '연결 확인 필요' : complete ? '이번 표본 선택 확인' : running ? '표본 수집 중 / 확인 필요' : '표본 선택 미확인';
    badge.className = 'badge ' + (!connected ? 'unknown' : complete ? 'pass' : running ? 'running' : 'unknown');
    const exhibitions = Number(state.discovery?.totalExhibitions);
    $('coverage-description').textContent = `수집 중 확인한 공개 전시 ${Number.isFinite(exhibitions) ? exhibitions.toLocaleString('ko-KR') : '미확인'}개 · 이번 점검 대상 ${total.toLocaleString('ko-KR')}경로. 전체 전시 전수 검사 결과가 아닙니다.`;
    $('coverage-source').textContent = state.discovery?.source ? '수집 경로: ' + String(state.discovery.source) : '';
    const errors = Array.isArray(state.discovery?.errors) ? state.discovery.errors : [];
    $('discovery-errors').hidden = !errors.length;
    $('discovery-errors').replaceChildren(...errors.map((error) => el('li', '', issueMessage(error))));
    $('sampling-meta').textContent = sampling ? `선택 ${sampling.selectionId || '미확인'} · 선택 시각 ${formatDate(sampling.selectedAt)} · 공개·진행 중·비인증 입장 조건으로 선정` : '대표 표본 선택 메타가 없습니다. 이전 결과로 전체 서비스 상태를 판단할 수 없습니다.';
    const pool = sampling?.pool;
    $('sampling-pool').textContent = pool ? `후보 목록 ${Number.isSafeInteger(pool.listed) ? pool.listed : '미확인'} / ${Number.isSafeInteger(pool.declared) ? pool.declared : '미확인'}개 · ${Number.isSafeInteger(pool.pagesRead) ? pool.pagesRead : '미확인'}페이지 조회 · 공개 조건 확인 ${Number.isSafeInteger(pool.eligible) ? pool.eligible : '미확인'}개. ${pool.bounded ? '제한된 후보 목록에서 선정하므로 전체 공개 전시에 균등한 표본이 아닙니다.' : '전체 공개 전시에 대한 균등 표본을 보장하지 않습니다.'}` : '후보 목록 수집 범위가 미확인입니다. 전체 공개 전시에 균등한 표본으로 해석하지 마세요.';
    const types = { previews: '프리뷰', invitations: '초대장', viewers: '관람' };
    const entries = [];
    for (const [key, label] of Object.entries(types)) for (const row of sampling?.[key] || []) entries.push(el('li', '', `${row.family === 'archive-viewer' ? `아카이브 관람 · 아카이브 ID ${row.roomId}` : `${label} · ID ${row.roomId} · 해시 ${row.hash}`} · ${row.eligible === true ? row.reason === 'active-public-archive' ? '공개·진행 중인 보존 전시' : row.reason === 'verified-curator-fallback' ? '검증된 공개 큐레이터 대체 경로' : '공개·진행 중·비인증 입장' : '현재 공개 조건 미확인'}`));
    const families = { 'archive-viewer': '아카이브 관람', 'oneday-preview': '원데이 프리뷰', 'oneday-viewer': '원데이 관람', 'sample-invitation': '샘플 초대장' };
    for (const row of sampling?.unavailable || []) entries.push(el('li', '', `${families[row.family] || row.type || '선택'} · ${row.roomId ? `ID ${row.roomId} · ` : ''}조건을 확인하지 못해 미확인으로 남겼습니다.`));
    $('sampling-list').replaceChildren(...(entries.length ? entries : [el('li', '', '이번 실행에서 전시 표본을 아직 선택하지 못했습니다.')]));
  }
  function rowDetail(result) {
    const detail = el('div', 'page-detail');
    const evidence = el('div');
    evidence.append(el('p', 'detail-label', '검사 근거'));
    evidence.append(el('p', 'detail-meta', `그룹: ${result.group || '기타'} · 확인: ${formatDate(result.checkedAt)} · 응답: ${result.httpStatus ?? '미확인'} · 소요: ${Number.isFinite(result.durationMs) ? (result.durationMs / 1000).toFixed(1) + '초' : '미확인'}`));
    if (result.policy?.readOnly) evidence.append(el('p', 'detail-meta', `읽기 전용 차단 · 서비스 요청 ${Number(result.policy.blockedServiceWrites || 0) + Number(result.policy.blockedServiceSockets || 0)}건 · 외부 요청 ${Number(result.policy.blockedExternalWrites || 0) + Number(result.policy.blockedExternalSockets || 0)}건 (외부 분석 차단은 화면 판정을 바꾸지 않습니다)`));
    const groupedReadiness = result.diagnostics?.groups?.some(group => group.cause === 'readiness' || group.derivedKinds?.length);
    const issues = Array.isArray(result.issues) ? result.issues.filter(issue => !groupedReadiness || !['render-timeout', '3d-not-ready', 'loading', 'required-content'].includes(issue.kind)).map(issueMessage) : [];
    if (['pass', 'fail'].includes(result.status) && isStale(result)) issues.unshift(connected ? '이 결과는 오래되어 현재 상태를 미확인으로 표시합니다. 새 점검이 필요합니다.' : '점검 서버와 연결이 끊겨 현재 상태를 확인할 수 없습니다.');
    if (result.status === 'pending') issues.unshift('아직 이 페이지를 점검하지 않았습니다.');
    if (issues.length) {
      const list = el('ul', 'issue-list');
      list.append(...issues.map((issue) => el('li', '', issue)));
      evidence.append(list);
    }
    if (Array.isArray(result.checks) && result.checks.length) {
      const list = el('ul', 'check-list');
      for (const check of result.checks) {
        const item = el('li');
        item.append(el('span', 'dot ' + (check.passed === true ? 'dot-green' : check.passed === false ? 'dot-red' : 'dot-gray')), el('span', '', String(check.name || '검사')));
        if (check.detail) item.append(el('span', 'check-detail', String(check.detail)));
        list.append(item);
      }
      evidence.append(list);
    } else if (!issues.length) evidence.append(el('p', 'muted', '상세 검사 근거가 아직 없습니다.'));
    if (result.renderDiagnostics) { const d = result.renderDiagnostics; evidence.append(el('p', 'detail-meta', `콘솔 오류 ${Number(d.consoleErrors || 0)}개 · 스크롤 관측 ${Number(d.lazyViewports || 0)}화면 · 이미지 대기 ${Number(d.mediaPending || 0)}개 · 가로 넘침 ${(d.horizontalOverflow || d.layout?.overflow) ? '발견' : '없음'}`)); }
    evidence.append(renderDiagnostics(result));
    if (safeLink(result.url)) evidence.append(makeLink(result.url, '실제 페이지 열기 ↗', 'detail-link'));
    else if (result.identityWithheld) evidence.append(el('p', 'muted', result.identityWithheldReason || '공개 경로 식별자는 비공개이며 검사 판정은 유지합니다.'));
    if (!result.identityWithheld && result.urlWithheldReason) evidence.append(el('p', 'muted', result.urlWithheldReason));
    const capture = el('div');
    capture.append(el('p', 'detail-label', '점검 당시 화면'));
    if (!state.publicSummary && result.screenshot && safeLink(result.screenshot, true)) {
      const link = makeLink(result.screenshot, undefined, 'screenshot-link', true);
      const img = el('img');
      img.src = safeLink(result.screenshot, true);
      img.alt = `${result.name || result.id || '페이지'} 점검 당시 화면`;
      img.loading = 'lazy';
      img.addEventListener('error', () => { link.replaceChildren(el('span', 'no-screenshot', '캡처 파일을 불러올 수 없습니다')); }, { once: true });
      link.append(img, el('span', 'screenshot-caption', '화면 크게 보기 ↗'));
      capture.append(link);
    } else capture.append(el('div', 'no-screenshot', result.screenshotOmittedReason || '캡처 저장·게시는 기본으로 생략합니다'));
    const layers = el('div', 'layer-details');
    for (const key of LAYER_KEYS) {
      const layer = displayedLayer(result, key);
      const section = el('section', 'layer-detail');
      const heading = el('div', 'layer-card-heading');
      heading.append(el('h4', '', LAYER_LABELS[key]), layerBadge(layer));
      section.append(heading, el('p', 'layer-card-note', layer.required ? '이 페이지의 필수 단계' : '이 페이지 적용 제외 · 별도 업무 시나리오에서 확인'));
      if (layer.reason) section.append(el('p', 'case-reason', String(layer.reason)));
      if (layer.legacy && !result.renderOnly) section.append(el('p', 'legacy-label', '기존 렌더링 전용 보고서'));
      if (layer.cases.length) section.append(caseList(layer.cases));
      else if (key !== 'render') section.append(el('p', 'muted', layer.required ? '등록된 시나리오가 없습니다.' : '공개 페이지에서는 이 업무를 실행하지 않습니다.'));
      layers.append(section);
    }
    detail.append(evidence, capture, layers);
    return detail;
  }
  function caseList(cases) {
    const list = el('ul', 'case-list');
    for (const item of cases) {
      const row = el('li', 'case-item');
      const heading = el('div', 'case-heading');
      heading.append(el('strong', '', String(item.name || item.id || '시나리오')), layerBadge(item));
      const viewport = typeof item.viewport === 'string' ? item.viewport : item.viewport?.name || (item.viewport?.width && item.viewport?.height ? `${item.viewport.width}×${item.viewport.height}` : '미지정');
      const context = `역할 ${typeof item.role === 'string' ? item.role : '미지정'} · 실행 ${typeof item.mode === 'string' ? item.mode : '미지정'} · 화면 ${viewport}`;
      row.append(heading, el('p', 'case-context', context));
      if (item.reason) row.append(el('p', 'case-reason', String(item.reason)));
      else if (item.status !== 'pass') row.append(el('p', 'case-reason', `${LAYER_STATUS_LABELS[item.status]}: 실행 근거 또는 사유를 확인해야 합니다.`));
      if (item.evidenceScope) row.append(el('p', 'case-context', item.evidenceScope === 'isolated-app' ? '근거 범위: 격리된 실제 앱' : '근거 범위: 로컬 비공개 기록 · 업무 통과 근거와 구분'));
      if (item.capabilities) {
        row.append(el('p', 'case-context', '구현·검증 준비 상태 · 업무 통과와 별도'));
        const capabilities = el('ul', 'check-list');
        for (const [key, label] of Object.entries(CAPABILITY_LABELS)) {
          const entry = el('li');
          entry.append(el('span', 'dot ' + (item.capabilities[key] ? 'dot-green' : 'dot-gray')), el('span', '', `${label}: ${item.capabilities[key] ? '확인' : '미확인'}`));
          capabilities.append(entry);
        }
        row.append(capabilities);
      }
      if (!state.publicSummary && item.adapterBlocker && !String(item.reason || '').includes(item.adapterBlocker)) row.append(el('p', 'case-reason', '연결 검증 차단 사유: ' + item.adapterBlocker));
      if (item.checks.length) {
        const checks = el('ul', 'check-list');
        for (const check of item.checks) {
          const entry = el('li');
          entry.append(el('span', 'dot ' + (check.passed === true ? 'dot-green' : check.passed === false ? 'dot-red' : 'dot-gray')), el('span', '', String(check.name || '확인 항목')));
          if (typeof check.detail === 'string') entry.append(el('span', 'check-detail', check.detail));
          checks.append(entry);
        }
        row.append(checks);
      }
      list.append(row);
    }
    return list;
  }
  function renderResults() {
    const results = Array.isArray(state?.results) ? state.results : [];
    const groups = [...new Set(results.map((result) => result.group).filter(Boolean))].sort();
    const selectedGroup = $('group-filter').value;
    const firstOption = el('option', '', '모든 그룹'); firstOption.value = '';
    $('group-filter').replaceChildren(firstOption, ...groups.map((group) => { const option = el('option', '', String(group)); option.value = String(group); return option; }));
    $('group-filter').value = groups.includes(selectedGroup) ? selectedGroup : '';
    const query = $('search').value.trim().toLocaleLowerCase();
    const shown = results.filter((result) => (filter === 'all' || statusOf(result) === filter) && (!$('group-filter').value || result.group === $('group-filter').value) && (!query || [result.name, result.url, result.group, result.id].some((value) => String(value || '').toLocaleLowerCase().includes(query))));
    const priorities = { fail: 0, unknown: 1, pass: 2 };
    shown.sort((a, b) => priorities[statusOf(a)] - priorities[statusOf(b)] || String(a.name || a.id).localeCompare(String(b.name || b.id), 'ko'));
    $('visible-count').textContent = `${shown.length.toLocaleString('ko-KR')} / ${results.length.toLocaleString('ko-KR')}`;
    const openRows = new Set([...$('results').querySelectorAll('details[open]')].map((node) => node.dataset.id));
    const fragment = document.createDocumentFragment();
    if (!shown.length) {
      const empty = el('div', 'empty-state');
      empty.append(el('span', 'empty-symbol', '◎'), el('h3', '', results.length ? '조건에 맞는 페이지가 없습니다' : '아직 점검 결과가 없습니다'), el('p', '', results.length ? '다른 상태 또는 검색어로 확인해 주세요.' : '첫 점검이 시작되면 공개 페이지가 여기에 표시됩니다.'));
      fragment.append(empty);
    } else {
      const head = el('div', 'results-header');
      head.setAttribute('aria-hidden', 'true');
      head.append(el('span', '', '점검 상태'), el('span', '', '페이지'), el('span', 'group-column', '구분'), el('span', 'time-column', '최근 확인'), el('span'));
      fragment.append(head);
      for (const result of shown) {
        const status = statusOf(result);
        const row = el('details', 'page-row'); row.dataset.id = String(result.id || result.url); row.open = openRows.has(row.dataset.id);
        const summary = el('summary', 'page-summary');
        const badge = el('span', 'status-label ' + status);
        badge.append(el('span', 'dot dot-' + (status === 'pass' ? 'green' : status === 'fail' ? 'red' : 'gray')), document.createTextNode(status === 'unknown' && result.status === 'pending' ? labels.pending : labels[status]));
        const identity = el('span'); identity.append(el('span', 'page-name', String(result.name || result.id || '페이지')), el('span', 'page-path', String(result.url || result.urlWithheldReason || (result.identityWithheld ? '공개 경로 식별자 비공개' : '주소 없음'))));
        const layerLine = el('span', 'page-layers');
        for (const [key, prefix] of [['render', '화면 '], ['navigation', '이동 '], ['business', '업무 ']]) layerLine.append(layerBadge(displayedLayer(result, key), prefix));
        identity.append(layerLine);
        if (!result.renderOnly && (!result.layers || result.scope === 'render-only')) identity.append(el('span', 'legacy-label', '기존 렌더링 전용'));
        summary.append(badge, identity, el('span', 'group-text', String(result.group || '기타')), el('span', 'time-text', formatDate(result.checkedAt)), el('span', 'chevron', '›'));
        row.append(summary, rowDetail(result));
        fragment.append(row);
      }
    }
    $('results').replaceChildren(fragment);
  }
  function renderHistory() {
    const history = Array.isArray(state.history) ? state.history.slice(-10).reverse() : [];
    if (!history.length) { $('history').replaceChildren(el('p', 'muted', '완료된 점검 이력이 아직 없습니다.')); return; }
    const grid = el('div', 'history-grid');
    for (const run of history) {
      const item = el('article', 'history-item');
      const time = el('time', '', formatDate(run.completedAt));
      if (run.completedAt) time.dateTime = run.completedAt;
      item.append(time);
      const renderOnly = run.scope !== 'required-layers';
      if (renderOnly) item.append(el('p', 'history-scope', '기존 렌더링 전용 · 업무 통과와 구분'));
      const bar = el('div', 'history-bar'); bar.setAttribute('aria-hidden', 'true');
      const total = Number(run.total) || 1;
      const legend = el('p');
      for (const [status, color] of [['pass', 'green'], ['fail', 'red'], ['unknown', 'gray']]) {
        const count = Math.max(0, Number(run[status]) || 0);
        const segment = el('span', 'dot-' + color); segment.style.width = Math.min(100, count / total * 100) + '%'; bar.append(segment);
        const label = el('span'); label.append(el('span', 'dot dot-' + color), document.createTextNode(`${renderOnly && status === 'pass' ? '화면 통과' : labels[status]} ${count}`)); legend.append(label);
      }
      item.append(bar, legend); grid.append(item);
    }
    $('history').replaceChildren(grid);
  }
  function render() {
    if (!state) return;
    renderOverview(Array.isArray(state.results) ? state.results : []);
    renderResults();
    renderHistory();
  }
  async function refresh() {
    if (fetching) return;
    fetching = true;
    lastFetchAt = Date.now();
    try {
      const response = await fetch(new URL(document.querySelector('meta[name="monitor-report"]')?.content || 'api/status', document.baseURI), { cache: 'no-cache', signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json();
      if (!next || !Array.isArray(next.results)) throw new Error('올바른 점검 결과를 받지 못했습니다');
      state = next; connected = true;
      $('connection-error').hidden = true;
    } catch (error) {
      connected = false;
      $('connection-error').textContent = `점검 서버에 연결할 수 없습니다. 이전 결과는 미확인으로 표시합니다. (${error.message})`;
      $('connection-error').hidden = false;
      $('run-button').disabled = true;
      if (!state) { $('overview-title').textContent = '점검 서버에 연결할 수 없습니다'; $('overview-description').textContent = '연결이 복구되면 자동으로 다시 확인합니다.'; }
    } finally { fetching = false; render(); }
  }
  $('run-button').addEventListener('click', async () => {
    if (state?.readOnly) { const url = safeLink(state.workflowUrl); if (url) window.open(url, '_blank', 'noopener,noreferrer'); return; }
    requestingRun = true; $('run-button').disabled = true; $('action-message').textContent = '전체 점검을 요청하고 있습니다…';
    try {
      const response = await fetch(new URL('api/run', document.baseURI), { method: 'POST', signal: AbortSignal.timeout(15_000) });
      if (response.status === 409) $('action-message').textContent = '이미 전체 점검이 진행 중입니다.';
      else if (!response.ok) throw new Error(`HTTP ${response.status}`);
      else $('action-message').textContent = '전체 점검을 시작했습니다. 결과는 페이지별로 갱신됩니다.';
    } catch (error) { $('action-message').textContent = `점검을 시작할 수 없습니다. ${error.message}`; }
    finally { requestingRun = false; await refresh(); }
  });
  for (const tab of document.querySelectorAll('[data-filter]')) tab.addEventListener('click', () => {
    filter = tab.dataset.filter;
    for (const button of document.querySelectorAll('[data-filter]')) { const active = button === tab; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
    renderResults();
  });
  $('group-filter').addEventListener('change', renderResults);
  $('search').addEventListener('input', renderResults);
  refresh();
  setInterval(() => { if (!state?.readOnly || Date.now() - lastFetchAt >= 60_000) refresh(); }, 5_000);
})();
