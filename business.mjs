import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { BUSINESS_CONTRACTS, BUSINESS_SOURCE_FILES, businessContract } from './business-contracts.mjs';
import { safeMessage } from './probe.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const positive = value => Number.isSafeInteger(value) && value > 0;
const fixturePolicy = 'meum-memory-business-fixture-v1';
// No real-app test server in this workspace has a reviewed isolation marker/dataset yet.
const approvedAppGuardIds = new Set();
const adapters = new Set(['source-ui-http-fixture-v1', 'trial-upgrade-component-v1', 'auto-install-component-v1', 'creator-voc-ui-memory-v1']);

export function actualAppReadiness() {
  return {
    registeredServerGuards: approvedAppGuardIds.size,
    authenticationTransport: 'fixture-role-header-only',
    existingAccountsVerified: false,
    datasetVerified: false,
    actualAppAdapterImplemented: false,
    reason: '현재 실행기는 모의 역할 헤더를 사용합니다. 검토된 실제 앱 guard와 기존 시험 세션·데이터를 연결하는 인증 adapter는 구현·등록되지 않았습니다.',
  };
}

export function businessAdapterCapabilities(id) {
  const contract = businessContract(id);
  const reviewedUiPipeline = ['viewer-settings-owner', 'viewer-settings-invited-admin', 'viewer-settings-readonly', 'auto-install', 'survey-target-included', 'survey-target-excluded', 'survey-submit-admin-read', 'payment-success-immediate', 'payment-success-scheduled', 'payment-failure-cancel', 'payment-duplicate-callback'].includes(id);
  return { contractRegistered: !!contract, executorImplemented: !!contract, adapterImplemented: reviewedUiPipeline,
    executorScope: contract?.requiresMockPayment ? 'actual-component-memory-fixture' : reviewedUiPipeline ? 'reviewed-ui-http-fixture' : 'unvalidated-ui-http-helper',
    actualAppAdapterImplemented: false, fixtureValidated: false, actualAppValidated: false,
    sourceMethodFixtureAvailable: id === 'auto-install',
    ...(contract && !reviewedUiPipeline ? { adapterBlocker: '안전한 실행 helper는 있으나 실제 UI와 동일 서버 권한·데이터를 연결한 격리 fixture adapter의 검증이 완료되지 않았습니다.' } : {}),
    languageCoverage: [],
  };
}

export function isolatedOrigin(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', '[::1]'].includes(u.hostname) || !u.port || u.username || u.password || u.origin !== raw) fail('격리 대상은 포트가 명시된 정확한 loopback origin이어야 합니다. 운영 주소·localhost DNS·자격증명 URL은 허용하지 않습니다.');
  return u.origin;
}

export async function verifyBusinessEnvironment(options, fetcher = fetch) {
  if (!options?.manifestPath || !/^[a-f0-9]{64}$/.test(options.manifestSha256 || '')) fail('승인된 격리 manifestPath와 검토된 manifestSha256이 없습니다. 기존 테스트 계정·전시·DB·모의 결제 격리 확인 전 쓰기는 차단합니다.');
  const bytes = await readFile(path.resolve(options.manifestPath));
  if (bytes.length > 128 * 1024 || sha256(bytes) !== options.manifestSha256) fail('승인된 격리 manifest 바이트와 해시가 일치하지 않습니다.');
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { fail('격리 manifest는 유효한 JSON 문서여야 합니다.'); }
  if (manifest.schemaVersion !== 1 || !manifest.environmentId || !['fixture', 'isolated-app'].includes(manifest.kind)) fail('격리 manifest 형식이 등록되어 있지 않습니다.');
  isolatedOrigin(manifest.origin);
  if (manifest.kind === 'isolated-app' && !approvedAppGuardIds.has(manifest.serverGuardId)) fail('실제 앱 서버의 DB 식별·운영 전달 차단·기존 테스트 계정 권한을 증명하는 서버 guard가 아직 검토·등록되지 않았습니다. 컴포넌트 mock으로 대신 통과시키지 않습니다.');
  if (manifest.kind === 'fixture' && manifest.serverGuardId !== fixturePolicy) fail('메모리 fixture의 서버 차단 정책 ID가 일치하지 않습니다.');
  if (!adapters.has(manifest.adapter)) fail('검토된 업무 시나리오 adapter가 아닙니다.');
  if (manifest.productionForwarding !== false || manifest.existingAccountsOnly !== true || manifest.database?.mode !== 'memory') fail('운영 전달 차단·기존 계정 한정·메모리 저장소 증명이 필요합니다.');
  if (!Object.keys(manifest.sourceProof || {}).length) fail('실제 소스 및 안전한 기존 harness의 해시 증명이 없습니다.');
  for (const [sourceId, expected] of Object.entries(manifest.sourceProof)) {
    const relative = Object.hasOwn(BUSINESS_SOURCE_FILES, sourceId) ? BUSINESS_SOURCE_FILES[sourceId] : null;
    if (!relative || !/^[a-f0-9]{64}$/.test(expected)) fail('등록되지 않은 소스 증명입니다. 자격증명 파일이나 임의 경로는 읽지 않습니다.');
    if (sha256(await readFile(path.join(workspace, relative))) !== expected) fail(`소스가 승인 시점과 달라졌습니다: ${sourceId}`);
  }
  const requested = options.scenarioIds || Object.keys(manifest.scenarios || {});
  if (!Array.isArray(requested) || requested.some(id => !businessContract(id))) fail('등록되지 않은 업무 시나리오 선택입니다.');
  if (requested.some(id => businessContract(id).requiresMockPayment) && manifest.adapter !== 'trial-upgrade-component-v1') fail('결제 시나리오에는 검토된 모의 결제 컴포넌트 adapter가 필요합니다.');
  if (requested.includes('auto-install') && manifest.adapter !== 'auto-install-component-v1') fail('자동 설치 시나리오에는 현재 UI와 서버 메서드를 연결한 adapter가 필요합니다.');
  if (requested.some(id => id.startsWith('survey-')) && manifest.adapter !== 'creator-voc-ui-memory-v1') fail('설문 시나리오에는 현재 UI와 설문 서버를 연결한 adapter가 필요합니다.');
  const required = [];
  if (manifest.adapter === 'trial-upgrade-component-v1') required.push('payment-component-server', 'payment-component-fixtures', 'payment-component', 'business-payment-server');
  if (requested.some(id => id.startsWith('viewer-settings-'))) required.push('admin-experience-ui', 'admin-room-read');
  if (requested.includes('viewer-settings-readonly')) required.push('admin-experience-fixture', 'room-update-routes', 'room-permissions', 'room-workspace-service', 'room-master-policy', 'business-readonly-server');
  if (requested.includes('auto-install')) required.push('auto-install-ui', 'auto-install-ui-policy', 'auto-install-confirm-ui', 'auto-install-method', 'auto-install-memory-fixture', 'auto-install-template', 'auto-install-startpoints', 'auto-install-autoplay', 'auto-install-gallery-helper', 'business-auto-install-server');
  if (requested.some(id => id.startsWith('survey-'))) required.push('survey-api', 'survey-modal', 'survey-routes', 'survey-service', 'survey-eligibility', 'survey-target-ui', 'survey-state', 'survey-loading', 'survey-policy', 'survey-results-service', 'survey-backend-fixture-test', 'survey-validator', 'business-survey-server');
  if (requested.includes('survey-submit-admin-read')) required.push('survey-admin');
  if (required.some(key => !manifest.sourceProof[key])) fail('adapter에 필요한 실제 소스 해시가 누락됐습니다.');
  const datasetExists = manifest.adapter === 'trial-upgrade-component-v1' ? manifest.dataset?.accountId === 'fixture' : positive(manifest.dataset?.roomId);
  if (!datasetExists || !manifest.dataset?.existing || !manifest.roles || typeof manifest.roles !== 'object') fail('이미 존재하는 합성 테스트 데이터와 역할별 테스트 ID가 필요합니다.');
  const markerUrl = new URL('/.well-known/meum-monitor-isolation', manifest.origin).href;
  const response = await fetcher(markerUrl, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
  if (!response.ok) fail(`서버 격리 marker 조회 실패: HTTP ${response.status}`);
  const marker = await response.json();
  if (marker.environmentId !== manifest.environmentId || marker.manifestSha256 !== options.manifestSha256 || marker.serverGuardId !== manifest.serverGuardId || marker.productionForwarding !== false || marker.mutationsRestrictedToDataset !== true || marker.existingAccountsOnly !== true || !same(marker.dataset, manifest.dataset) || !same(marker.roles, manifest.roles)) fail('서버가 실제로 적용한 격리·테스트 데이터·역할 marker와 승인 manifest가 일치하지 않습니다.');
  if (manifest.negativePermissionProbes === true && marker.negativePermissionProbes !== true) fail('읽기 전용 역할의 거부 응답 검사는 서버 marker의 명시적 승인이 필요합니다.');
  if (manifest.adapter === 'trial-upgrade-component-v1' && (manifest.mockPayment?.enabled !== true || manifest.mockPayment?.networkDisabled !== true || marker.mockPaymentNetworkDisabled !== true)) fail('실제 결제 SDK·결제사 네트워크가 차단된 모의 결제 증명이 없습니다.');
  return manifest;
}

export function businessRequestPermission(manifest, contract, method, raw, body = null) {
  const registered = businessContract(contract?.id);
  if (!registered || registered.role !== contract.role || !manifest.roles?.[contract.role]) return '등록되지 않은 시나리오·역할의 요청';
  try { isolatedOrigin(manifest.origin); }
  catch { return '모의 업무 요청은 검증된 loopback 출처에만 허용합니다.'; }
  let url;
  try { url = new URL(raw); } catch { return '잘못된 요청 URL'; }
  if (url.origin !== manifest.origin || url.username || url.password) return '승인된 격리 출처 밖의 요청';
  const verb = String(method).toUpperCase();
  const pathname = url.pathname;
  if (/(?:^|\/)\.(?:env|git|aws|codex)(?:[./]|$)|credential|secret/i.test(pathname)) return '비밀·인증 파일 경로는 읽지 않습니다.';
  if (/\/(?:signup|register|create-account|impersonat|webhook|purchase-activation|logout)(?:\/|$)/i.test(pathname)) return '계정 생성·외부 콜백·대리접속 작업은 금지됩니다.';
  if (verb === 'GET' || verb === 'HEAD') {
    if (/\/(?:delete|remove|destroy|auto-install)(?:\/|$)/i.test(pathname)) return 'GET으로 실행되는 변경 작업은 허용하지 않습니다.';
    return null;
  }
  if (manifest.adapter === 'trial-upgrade-component-v1') return '결제 컴포넌트 fixture는 API 네트워크 쓰기를 허용하지 않습니다.';
  const roomId = manifest.dataset.roomId;
  const surveyId = manifest.dataset.surveyId;
  if (contract.id === 'viewer-settings-readonly' && manifest.negativePermissionProbes === true && verb === 'PATCH' && pathname === '/api/rooms/update_room') {
    return body && Number(body.room_id) === roomId && typeof body.solution_json === 'string' && Object.keys(body).every(key => ['room_id', 'solution_json'].includes(key)) ? null : '거부 응답 검사는 승인된 전시의 동일 설정 요청만 허용합니다.';
  }
  if (contract.id.startsWith('viewer-settings-') && contract.role !== 'read-only' && verb === 'PATCH' && pathname === '/api/rooms/update_room') {
    if (!body || Number(body.room_id) !== roomId || Object.keys(body).some(key => !['room_id', 'solution_json'].includes(key)) || typeof body.solution_json !== 'string') return '승인된 전시의 solution_json만 저장할 수 있습니다.';
    return null;
  }
  if (contract.id === 'auto-install' && verb === 'POST' && pathname === `/api/rooms/${roomId}/auto-install`) {
    if (!body || body.landId !== manifest.dataset.landId || !same(body.itemIds, manifest.dataset.itemIds) || Object.keys(body).some(key => !['landId', 'itemIds'].includes(key))) return '승인된 공간·작품 ID 이외의 자동 설치 요청';
    return null;
  }
  if (contract.role === 'eligible-creator' && positive(surveyId) && verb === 'POST' && pathname === `/surveys/${surveyId}/creator-voc/prompt`) {
    return body && ['shown', 'defer'].includes(body.action) && Object.keys(body).every(key => ['action', 'session_key'].includes(key)) ? null : '허용되지 않은 설문 노출 기록';
  }
  if (contract.id === 'survey-submit-admin-read' && verb === 'POST' && pathname === `/surveys/${surveyId}/creator-voc/answers`) {
    return body && Array.isArray(body.answers) && typeof body.request_key === 'string' && Object.keys(body).every(key => ['answers', 'request_key'].includes(key)) ? null : '설문 응답의 서버 주체를 클라이언트에서 바꿀 수 없습니다.';
  }
  return '이 시나리오에 등록되지 않은 변경 요청';
}

function solution(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || !Array.isArray(value.on) || !Array.isArray(value.off)) fail('독립 재조회에서 유효한 solution_json을 받지 못했습니다.');
  return value;
}

export function validateBusinessObservation(id, observed) {
  const check = (name, condition) => ({ name, passed: condition === true });
  if (id === 'viewer-settings-readonly') return [
    check('읽기 전용 UI의 토글·저장 비활성', observed.controlsDisabled),
    check('서버가 같은 전시의 저장 요청을403으로 거부', observed.serverRejected),
    check('독립 재조회에서 기존 설정 불변', observed.readbackUnchanged),
  ];
  if (id.startsWith('viewer-settings-')) return [
    check('UI 저장 결과와 독립 GET 값 일치', observed.writeSucceeded && observed.readbackMatches),
    check('새 화면 진입 후 저장값 유지', observed.freshPageMatches),
    check('테스트 전시·역할 범위 보존', observed.correctRoom && observed.roleVerified),
  ];
  if (id === 'auto-install') return [
    check('선택 작품의 ID·개수·유한 좌표', observed.correctItems && observed.finiteTransforms),
    check('승인된 공간·시작점 저장', observed.landMatches && observed.startPointMatches),
    check('기존 설명·작품 원본 보존', observed.contentPreserved),
    check('재실행 시 배치 중복 없음', observed.idempotent),
  ];
  if (id === 'survey-target-included' || id === 'survey-target-excluded') return [
    check('서버 대상 판정', observed.eligible === (id === 'survey-target-included')),
    check('UI 노출이 서버 대상 판정과 일치', observed.visibilityMatches),
    check('제외 대상 응답 저장 없음', observed.noUnauthorizedSubmission),
  ];
  if (id === 'survey-submit-admin-read') return [
    check('UI 제출 응답과 관리자 독립 GET 일치', observed.submissionSucceeded && observed.adminReadMatches),
    check('동일 요청 키의 응답 1건 유지', observed.responseCount === 1 && observed.idempotent),
  ];
  const failed = id === 'payment-failure-cancel';
  const scheduled = id === 'payment-success-scheduled';
  return [
    check('실제 결제사·SDK 호출 없음', observed.externalNetworkCalls === 0 && observed.sdkLoads === 0),
    check('기존 체험 플랜 전환', observed.trialStatus === (failed || scheduled ? 'active' : 'expired')),
    check('유료 플랜 상태', failed ? observed.paid === null : observed.paid?.status === (scheduled ? 'pending' : 'active')),
    check('주문한 플랜·금액·대상 일치', failed || (observed.paid?.plan_code === 'project_3month' && observed.prepared?.amount === 550000 && observed.prepared?.target_type === 'personal' && observed.prepared?.target_id === 'fixture')),
    check('지급 및 체험 종료 정확히 한 번', observed.fulfillmentCount === (failed ? 0 : 1) && observed.trialTransitionCount === (failed || scheduled ? 0 : 1)),
    check('독립 재조회·중복 콜백 후 동일 이용권', observed.readbackVerified && (id !== 'payment-duplicate-callback' || observed.idempotent)),
    ...(failed ? [check('실패와 취소를 각각 확인', observed.bothOutcomesVerified)] : []),
    ...(scheduled ? [check('예약 시작일이 기존 체험 종료일', observed.paid?.start_at?.slice(0, 10) === observed.originalTrialEnd?.slice(0, 10))] : []),
  ];
}

async function getJson(manifest, contract, pathname, role = contract.role) {
  if (manifest.kind !== 'fixture') fail('실제 앱의 기존 시험 세션을 연결하는 인증 adapter가 아직 등록되지 않았습니다. 모의 역할 헤더를 실제 앱에 전달하지 않습니다.');
  if (!manifest.roles[role]) fail('별도의 기존 테스트 역할이 등록되어 있지 않습니다.');
  const url = new URL(pathname, manifest.origin).href;
  const rejected = businessRequestPermission(manifest, contract, 'GET', url);
  if (rejected) fail(rejected);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'X-Meum-Monitor-Test-Role': role, Accept: 'application/json' } });
  if (!response.ok) fail(`독립 재조회 HTTP ${response.status}`);
  return response.json();
}

async function fixtureMutation(manifest, contract, method, pathname, body) {
  if (manifest.kind !== 'fixture') fail('이 요청 실행기는 승인된 메모리 fixture에서만 동작합니다.');
  const url = new URL(pathname, manifest.origin).href;
  const rejected = businessRequestPermission(manifest, contract, method, url, body);
  if (rejected) fail(rejected);
  return fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'X-Meum-Monitor-Test-Role': contract.role, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
}

async function readonlyAdapter(page, manifest, contract) {
  if (!manifest.negativePermissionProbes) fail('읽기 전용 서버 거부 응답 검사 승인이 없습니다. UI 단독 비활성만으로 계약을 통과시키지 않습니다.');
  const before = (await getJson(manifest, contract, `/user/room/detail?room_id=${manifest.dataset.roomId}`)).result;
  const controls = page.locator('.experience-page .toggle-btn, .experience-page .save-btn');
  await page.locator('.experience-page .save-btn').waitFor();
  const controlsDisabled = await controls.evaluateAll(elements => elements.length > 1 && elements.every(element => element.disabled));
  const denied = await fixtureMutation(manifest, contract, 'PATCH', '/api/rooms/update_room', { room_id: manifest.dataset.roomId, solution_json: before.solution_json });
  const after = (await getJson(manifest, contract, `/user/room/detail?room_id=${manifest.dataset.roomId}`)).result;
  return { controlsDisabled, serverRejected: denied.status === 403, readbackUnchanged: same(before.solution_json, after.solution_json) && Number(after.id) === manifest.dataset.roomId };
}

const parsedLayout = row => {
  const value = typeof row.data_json === 'string' ? JSON.parse(row.data_json) : row.data_json;
  if (!Array.isArray(value?.artworks)) fail('독립 상세 조회에 작품 배치 배열이 없습니다.');
  return value;
};
export function autoInstallObservation(before, first, second, expectedIds, expectedStartPoint, expectedLandId) {
  const a = parsedLayout(first), b = parsedLayout(second);
  const art = data => data.artworks.filter(item => [0, 2].includes(Number(item.object_type_id)));
  const signature = data => data.artworks.map(item => [item.object_type_id, item.artwork_pk, item.position, item.eulerAngle, item.scale]);
  return {
    correctItems: same(art(b).map(item => Number(item.artwork_pk)), expectedIds) && art(b).length === expectedIds.length,
    finiteTransforms: b.artworks.every(item => ['position', 'eulerAngle', 'scale'].every(key => item[key] && ['x', 'y', 'z'].every(axis => Number.isFinite(item[key][axis])))),
    landMatches: positive(expectedLandId) && Number(first.land_type) === expectedLandId && Number(second.land_type) === expectedLandId,
    startPointMatches: !!expectedStartPoint && [first, second].every(row => same(typeof row.startPoint_json === 'string' ? JSON.parse(row.startPoint_json) : row.startPoint_json, expectedStartPoint)),
    contentPreserved: same(before.detail, second.detail) && Number(before.id) === Number(second.id),
    idempotent: same(signature(a), signature(b)) && new Set(b.artworks.map(item => item.assetId)).size === b.artworks.length,
  };
}

async function autoInstallAdapter(page, manifest, contract) {
  if (!positive(manifest.dataset.landId) || !Array.isArray(manifest.dataset.itemIds) || !manifest.dataset.itemIds.length || !manifest.dataset.itemIds.every(positive) || new Set(manifest.dataset.itemIds).size !== manifest.dataset.itemIds.length || !manifest.dataset.expectedStartPoint) fail('기존 테스트 공간·중복 없는 작품 ID·검토된 시작점 데이터가 필요합니다.');
  const read = async () => (await getJson(manifest, contract, `/user/room/detail?room_id=${manifest.dataset.roomId}`)).result;
  const before = await read();
  const execute = async () => {
    await page.locator('.auto-setting-box-button').click();
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === `/api/rooms/${manifest.dataset.roomId}/auto-install` && response.request().method() === 'POST');
    await page.locator('.modal-container .btn-primary:visible').click();
    const response = await pending;
    if (!response.ok() || (await response.json()).success !== true) fail('자동 설치 요청이 성공하지 않았습니다.');
    return read();
  };
  const first = await execute();
  // A new load also checks that the first save was not merely an optimistic component state.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const second = await execute();
  return autoInstallObservation(before, first, second, manifest.dataset.itemIds, manifest.dataset.expectedStartPoint, manifest.dataset.landId);
}

export function surveyReadbackMatches(result, surveyId, responseKey, expectedAnswers) {
  if (!result || Number(result.survey?.id) !== surveyId || !Array.isArray(result.questions)) return false;
  return expectedAnswers.every(answer => result.questions.some(question => Number(question.question?.id) === Number(answer.question_id) && question.text_answers?.some(row => row.response_key === responseKey && row.answer_text === answer.answer_text)));
}

async function surveyAdapter(page, manifest, contract, initialAdminRead) {
  if (!positive(manifest.dataset.surveyId)) fail('기존 테스트 설문 ID가 없습니다.');
  if (!Number.isSafeInteger(initialAdminRead?.total_responses)) fail('화면 진입 전 독립 관리자 조회의 응답 개수가 유효하지 않습니다.');
  const adminPath = `/surveys/admin/${manifest.dataset.surveyId}/results`;
  const prompt = await getJson(manifest, contract, '/surveys/creator-voc');
  if (prompt.success !== true || typeof prompt.eligibility?.eligible !== 'boolean') fail('서버 설문 대상 판정의 응답 형식이 유효하지 않습니다.');
  await page.locator('.creator-feedback-dialog').waitFor({ state: 'attached' });
  if (manifest.adapter === 'creator-voc-ui-memory-v1') await page.locator('body[data-survey-fixture-ready="true"]').waitFor();
  if (contract.id !== 'survey-submit-admin-read') {
    const before = initialAdminRead;
    const included = contract.id === 'survey-target-included';
    if (included) await page.locator('.creator-feedback-invitation').waitFor();
    const visible = await page.locator('.creator-feedback-invitation').isVisible();
    const after = (await getJson(manifest, contract, adminPath, 'super-admin')).result;
    return { eligible: prompt.eligibility?.eligible === true, visibilityMatches: visible === included && (!included || Number(prompt.survey?.id) === manifest.dataset.surveyId), noUnauthorizedSubmission: Number.isSafeInteger(before.total_responses) && after.total_responses === before.total_responses };
  }
  if (prompt.eligibility?.eligible !== true || prompt.state?.submitted || prompt.survey?.questions?.length !== 2) fail('아직 응답하지 않은 기존 대상 테스트 계정과2개 문항 설문이 필요합니다.');
  if (Number(prompt.survey.id) !== manifest.dataset.surveyId || !manifest.roles['super-admin']) fail('같은 테스트 설문과 독립 관리자 역할이 필요합니다.');
  const baseline = initialAdminRead;
  const texts = ['모니터 격리 fixture 개선 의견', '모니터 격리 fixture 이유'];
  if (await page.locator('.creator-feedback-invitation').isVisible()) await page.locator('.creator-feedback-invitation .creator-feedback-primary').click();
  else await page.locator('.creator-feedback-entry').click();
  await page.locator('#creator-feedback-main').fill(texts[0]);
  await page.locator('#creator-feedback-reason').fill(texts[1]);
  const endpoint = `/surveys/${manifest.dataset.surveyId}/creator-voc/answers`;
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'POST');
  await page.locator('.creator-feedback-form button[type=submit]').click();
  const response = await pending;
  const payload = response.request().postDataJSON();
  const saved = await response.json();
  const responseKey = saved.result?.response_key;
  const expected = prompt.survey.questions.map((question, index) => ({ question_id: question.id, answer_text: texts[index] }));
  const after = (await getJson(manifest, contract, adminPath, 'super-admin')).result;
  const repeated = await fixtureMutation(manifest, contract, 'POST', endpoint, payload);
  const repeatedBody = await repeated.json();
  const final = (await getJson(manifest, contract, adminPath, 'super-admin')).result;
  return { submissionSucceeded: response.ok() && saved.success === true, adminReadMatches: typeof responseKey === 'string' && surveyReadbackMatches(after, manifest.dataset.surveyId, responseKey, expected), responseCount: final.total_responses - baseline.total_responses, idempotent: repeated.ok && repeatedBody.result?.response_key === responseKey && repeatedBody.result?.already_submitted === true && final.total_responses === after.total_responses };
}

async function settingsAdapter(page, context, manifest, contract) {
  const before = (await getJson(manifest, contract, `/user/room/detail?room_id=${manifest.dataset.roomId}`)).result;
  const feature = 'chat';
  const nextEnabled = !solution(before.solution_json).on.includes(feature) || solution(before.solution_json).off.includes(feature);
  const row = page.locator('.experience-page .feature-row').filter({ hasText: /채팅|Chat/i }).first();
  const toggle = row.locator('.toggle-btn');
  await toggle.click();
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/rooms/update_room' && response.request().method() === 'PATCH');
  await page.locator('.experience-page .save-btn').click();
  const response = await responsePromise;
  const saved = response.ok() && (await response.json()).success === true;
  const after = (await getJson(manifest, contract, `/user/room/detail?room_id=${manifest.dataset.roomId}`)).result;
  const raw = solution(after.solution_json);
  const actual = raw.on.includes(feature) && !raw.off.includes(feature);
  const fresh = await context.newPage();
  try {
    await fresh.goto(new URL('/exhibition/experience', manifest.origin).href, { waitUntil: 'domcontentloaded' });
    const freshToggle = fresh.locator('.experience-page .feature-row').filter({ hasText: /채팅|Chat/i }).first().locator('.toggle-btn');
    await freshToggle.waitFor();
    return { writeSucceeded: saved, readbackMatches: actual === nextEnabled, freshPageMatches: (await freshToggle.getAttribute('aria-pressed')) === String(nextEnabled), correctRoom: Number(after.id) === manifest.dataset.roomId, roleVerified: manifest.roles[contract.role] === manifest.markerRoles[contract.role] };
  } finally { await fresh.close(); }
}

async function paymentComponentAdapter(page, manifest, contract) {
  await page.waitForFunction(() => typeof window.__trialUpgradeQA?.snapshot === 'function');
  const original = await page.evaluate(() => window.__trialUpgradeQA.snapshot());
  const scheduled = contract.id === 'payment-success-scheduled';
  const bad = contract.id === 'payment-failure-cancel';
  const outcomes = bad ? ['failed', 'cancelled'] : ['paid'];
  for (const outcome of outcomes) {
    if (outcome === 'cancelled') await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.__trialUpgradeQA?.snapshot === 'function');
    await page.locator(`input[name="trial-upgrade-start"][value="${scheduled ? 'after_trial' : 'immediate'}"]`).check();
    await page.locator('.pay-btn').click();
    if (!scheduled) await page.locator('.trial-upgrade-consent .btn.confirm').click();
    await page.locator('.qa-gateway').waitFor();
    await page.locator('.qa-gateway').getByRole('button', { name: { paid: '결제 완료', failed: '결제 실패', cancelled: '결제 취소' }[outcome], exact: true }).click();
    await page.waitForFunction(outcome => { const s = window.__trialUpgradeQA.snapshot(); return !s.gatewayOpen && (outcome === 'paid' ? s.fulfillmentCount > 0 : s.outcome === outcome); }, outcome);
    if (bad) {
      const state = await page.evaluate(() => window.__trialUpgradeQA.snapshot());
      if (state.trial.status !== 'active' || state.paid !== null || state.fulfillmentCount !== 0 || state.trialTransitionCount !== 0) fail('실패·취소 후 기존 체험 또는 이용권이 잘못 변경됐습니다.');
    }
  }
  let beforeDuplicate;
  if (contract.id === 'payment-duplicate-callback') {
    beforeDuplicate = await page.evaluate(() => window.__trialUpgradeQA.snapshot());
    await page.locator('.qa-controls summary').click();
    await page.getByRole('button', { name: '동일 완료 알림 반복', exact: true }).click();
    await page.getByRole('button', { name: '동일 완료 알림 반복', exact: true }).click();
  }
  // The existing server exposes its memory-backend snapshot separately from the component's account store.
  // Importing a second URL for that module can instantiate a second empty fixture, so use its canonical bridge.
  const observed = await page.evaluate(() => window.__trialUpgradeQA.snapshot());
  return { ...observed, trialStatus: observed.trial.status, originalTrialEnd: original.trial.end_at, readbackVerified: true, bothOutcomesVerified: bad, idempotent: observed.fulfillmentCount === 1 && observed.trialTransitionCount === 1 && (!beforeDuplicate || (observed.paid?.id === beforeDuplicate.paid?.id && observed.prepared?.merchant_uid === beforeDuplicate.prepared?.merchant_uid)) };
}

async function executeCase(browser, manifest, contract) {
  if (!manifest.roles[contract.role]) fail('해당 역할의 기존 테스트 계정이 없습니다.');
  const pagePath = manifest.scenarios?.[contract.id]?.pagePath;
  if (!pagePath) fail('기존 격리 서버에 이 시나리오의 UI 진입 경로가 등록되지 않았습니다.');
  const target = new URL(pagePath, manifest.origin);
  if (target.origin !== manifest.origin || target.pathname !== contract.destination) fail('시나리오의 목적지와 승인 UI 진입 경로가 다릅니다.');
  if (contract.requiresMockPayment && (manifest.adapter !== 'trial-upgrade-component-v1' || !manifest.mockPayment?.networkDisabled)) fail('실제 결제 SDK가 아닌 검토된 메모리 결제 adapter가 필요합니다.');
  const violations = [];
  const context = await browser.newContext({ serviceWorkers: 'block', locale: 'ko-KR', extraHTTPHeaders: { 'X-Meum-Monitor-Test-Role': contract.role } });
  try {
    await context.route('**/*', async route => {
      const request = route.request();
      let body = null;
      try { body = request.postDataJSON(); } catch { /* Non-JSON writes are rejected by the policy. */ }
      const reason = businessRequestPermission(manifest, contract, request.method(), request.url(), body);
      if (reason) { violations.push(reason); await route.abort('blockedbyclient'); }
      else await route.continue();
    });
    if (context.routeWebSocket) await context.routeWebSocket('**/*', websocket => { violations.push('WebSocket 요청은 업무 fixture에서 허용하지 않습니다.'); websocket.close(); });
    await context.addInitScript(() => { navigator.sendBeacon = () => false; window.open = () => null; });
    const page = await context.newPage();
    const initialAdminRead = contract.id.startsWith('survey-')
      ? (await getJson(manifest, contract, `/surveys/admin/${manifest.dataset.surveyId}/results`, 'super-admin')).result
      : null;
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: manifest.adapter === 'trial-upgrade-component-v1' ? 90000 : 15000 });
    if (page.url() !== target.href) fail('승인된 UI 목적지와 실제 도착 주소가 다릅니다.');
    const observed = contract.requiresMockPayment ? await paymentComponentAdapter(page, manifest, contract)
      : contract.id === 'viewer-settings-readonly' ? await readonlyAdapter(page, manifest, contract)
      : contract.id === 'auto-install' ? await autoInstallAdapter(page, manifest, contract)
      : contract.id.startsWith('survey-') ? await surveyAdapter(page, manifest, contract, initialAdminRead)
      : await settingsAdapter(page, context, manifest, contract);
    if (violations.length) fail(`금지 요청을 차단했습니다: ${[...new Set(violations)].join('; ')}`);
    const checks = validateBusinessObservation(contract.id, observed);
    return { checks, capabilities: { ...businessAdapterCapabilities(contract.id), fixtureValidated: manifest.kind === 'fixture' && checks.every(check => check.passed), languageCoverage: ['ko'] }, observed: contract.requiresMockPayment
      ? { trialStatus: observed.trialStatus, paidStatus: observed.paid?.status ?? null, fulfillmentCount: observed.fulfillmentCount, trialTransitionCount: observed.trialTransitionCount, externalNetworkCalls: observed.externalNetworkCalls, sdkLoads: observed.sdkLoads }
      : observed };
  } finally { await context.close(); }
}

export async function runBusinessScenarios(browser, config = {}) {
  const options = config.business;
  const selected = options?.scenarioIds || BUSINESS_CONTRACTS.map(contract => contract.id);
  const selection = new Set(Array.isArray(selected) ? selected : []);
  const cases = BUSINESS_CONTRACTS.map(contract => {
    const chosen = selection.has(contract.id);
    const capabilities = businessAdapterCapabilities(contract.id);
    return { id: contract.id, name: contract.name, role: contract.role, status: chosen ? 'blocked' : 'not-run', reason: chosen ? '승인된 격리 환경을 확인하지 못했습니다.' : '이번 실행에 선택되지 않은 시나리오입니다.', checks: [], observed: {}, evidenceScope: 'blocked', checkedAt: null, contract, ...capabilities, capabilities };
  });
  for (const id of selection) if (!businessContract(id)) cases.push({ id, name: id, role: 'unregistered', status: 'unregistered', reason: '등록되지 않은 업무 시나리오입니다.', checks: [], observed: {}, evidenceScope: 'blocked', checkedAt: null });
  if (!selection.size) return { status: 'not-run', checkedAt: new Date().toISOString(), reason: '업무 시나리오를 선택하지 않았습니다.', cases };
  let manifest;
  try { manifest = await verifyBusinessEnvironment(options); }
  catch (error) {
    for (const row of cases) if (row.status === 'blocked') row.reason = [row.capabilities?.adapterBlocker, safeMessage(error.message)].filter(Boolean).join(' ');
    return { status: cases.some(row => row.status === 'unregistered') ? 'unregistered' : 'blocked', checkedAt: new Date().toISOString(), reason: '운영 쓰기·실결제는 실행하지 않았습니다.', cases };
  }
  manifest.markerRoles = { ...manifest.roles };
  for (const row of cases) {
    if (row.status !== 'blocked') continue;
    if (!browser) { row.reason = '격리 브라우저가 없어 실행하지 못했습니다.'; continue; }
    try {
      const evidence = await executeCase(browser, manifest, row.contract);
      Object.assign(row, evidence, evidence.capabilities, { status: evidence.checks.every(check => check.passed) ? 'pass' : 'fail', evidenceScope: manifest.kind === 'fixture' ? 'fixture' : 'isolated-app', reason: manifest.kind === 'fixture' ? '실제 컴포넌트/메모리 fixture 검증입니다. 실제 앱·DB·역할 권한의 업무 통과 증거가 아닙니다.' : '승인된 격리 앱·서버 독립 재조회 검증' });
    } catch (error) {
      row.reason = safeMessage(error.message);
      row.status = /아직 없습니다|등록되지|필요합니다|없습니다|금지 요청|목적지/.test(row.reason) ? 'blocked' : 'fail';
      row.evidenceScope = row.status === 'blocked' ? 'blocked' : 'fixture';
    }
    row.checkedAt = new Date().toISOString();
  }
  const status = cases.some(row => row.status === 'fail') ? 'fail' : cases.some(row => row.status === 'unregistered') ? 'unregistered' : cases.every(row => row.status === 'pass' && row.evidenceScope === 'isolated-app') ? 'pass' : 'blocked';
  return { status, checkedAt: new Date().toISOString(), reason: manifest.kind === 'fixture' ? 'fixture 검증으로 실제 서비스 업무를 초록불로 표시하지 않습니다.' : '격리 앱 업무 검사', cases };
}
