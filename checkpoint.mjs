import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleFor } from './contracts.mjs';
import { classify } from './discovery.mjs';
import { contractFor, encodePublicRoomId, JOURNEY_MODES } from './journey-contracts.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const policy = 'meum-public-checkpoint-v2';
const files = ['ci-state.json', 'status.json'];
const fingerprintUrls = ['https://meum.me/home', 'https://archive.meum.me/'];
const layerStatuses = ['pass', 'fail', 'blocked', 'unregistered', 'not-run'];
const gateReasons = ['first-run', 'deployment-changed', 'deployment-dispatch', 'manual-six-hours', 'manual-once', 'fingerprint-check-failed', 'inside-deploy-window', 'outside-deploy-window', 'continuous'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0;
const iso = value => typeof value === 'string' && /^20\d\d-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const canonicalStatus = value => layerStatuses.includes(value) ? value : 'not-run';
const aggregate = items => ['fail', 'blocked', 'unregistered', 'not-run', 'pass'].find(value => items.includes(value)) || 'unregistered';
const reason = value => ({ pass: '공개 검사 조건을 통과했습니다.', fail: '공개 검사가 실패했습니다. 상세 근거는 로컬에 보관합니다.', blocked: '공개 검사의 실행 조건이 충족되지 않았습니다.', unregistered: '공개 검사 계약이 등록되지 않았습니다.', 'not-run': '새 공개 검사가 필요합니다.' })[canonicalStatus(value)];

function roomId(value) {
  const found = value && new URL(value).pathname.match(/^\/exhibition\/(?:preview\/)?([1-9]\d*)\/?$/);
  return found && Number.isSafeInteger(Number(found[1])) ? Number(found[1]) : null;
}

export function publicTargetUrl(raw, { parentUrl, parents } = {}) {
  try {
    if (typeof raw !== 'string' || raw.length > 600) return null;
    const url = new URL(raw);
    if (!['https://meum.me', 'https://archive.meum.me'].includes(url.origin) || url.username || url.password || raw.includes('#') || url.pathname.includes('%') || url.href !== raw) return null;
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (/(?:^|\/)(?:login|register|logout|admin|settings|account|my|dashboard|exhibition-dashboard|invitation)(?:\/|$)/i.test(pathname)) return null;
    if (ruleFor(raw).unsupported) return null;
    if (url.origin === 'https://meum.me' && pathname === '/meum-lite-viewer') {
      if (!parentUrl || !parents?.has(parentUrl) || new URL(parentUrl).origin !== 'https://meum.me') return null;
      const id = roomId(parentUrl);
      const encoded = id && encodePublicRoomId(id);
      return encoded && url.search === `?r=${encoded}` ? url.href : null;
    }
    if (raw.includes('?')) return null;
    // Opaque public slugs cannot be independently distinguished from private
    // identifiers here. Rediscover them with a fresh guest instead of caching.
    if (url.origin === 'https://meum.me' && /^\/(?:oneday|creator|webtoon)\//.test(pathname)) return null;
    if (url.origin === 'https://archive.meum.me' && !['/', '/archive'].includes(pathname) && !/^\/archive\/viewer\/[1-9]\d*$/.test(pathname)) return null;
    const exhibition = pathname.match(/^\/exhibition\/(?:preview\/)?(\d+)$/);
    if (exhibition && (!roomId(url.href) || String(roomId(url.href)) !== exhibition[1])) return null;
    if (url.origin === 'https://archive.meum.me' && pathname.startsWith('/archive/viewer/')) {
      const id = Number(pathname.split('/').at(-1));
      if (!Number.isSafeInteger(id) || id < 1 || (parentUrl && roomId(parentUrl) !== id)) return null;
    }
    return url.href;
  } catch { return null; }
}

function viewport(value) {
  if (!value || !['desktop', 'mobile', 'tablet'].includes(value.name) || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 100 || value.height < 100 || value.width > 4096 || value.height > 4096) return null;
  return { name: value.name, width: value.width, height: value.height, ...(typeof value.isMobile === 'boolean' ? { isMobile: value.isMobile } : {}) };
}

function envelope(row, context) {
  const view = viewport(row?.viewport);
  const parentUrl = row?.discoveredFrom ? publicTargetUrl(row.discoveredFrom) : null;
  const url = publicTargetUrl(row?.url, { ...context, parentUrl });
  if (!url || !view || typeof row.id !== 'string' || !/^[a-f0-9]{20}$/.test(row.id) || createHash('sha256').update(url + view.name).digest('hex').slice(0, 20) !== row.id) return null;
  return { url, id: row.id, viewport: view, ...(parentUrl && context?.parents?.has(parentUrl) ? { discoveredFrom: parentUrl } : {}) };
}

function checks(source) {
  return (Array.isArray(source) ? source : []).slice(0, 100).map((item, index) => ({ name: `확인 항목 ${index + 1}`, passed: typeof item?.passed === 'boolean' ? item.passed : null }));
}

export function expectedGuestCases(target) {
  const contract = contractFor(target);
  if (!contract) return [];
  const result = [];
  const actions = contract.actions || [];
  const cancelable = actions.some(action => ['overlay', 'search'].includes(action.kind));
  for (const mode of contract.modes || JOURNEY_MODES) {
    if (mode !== 'actions') result.push({ id: mode, mode, required: !(['cancel', 'repeat'].includes(mode) && !cancelable) });
    else if (!actions.length) result.push({ id: 'actions', mode, required: false });
    else for (const action of actions) {
      result.push({ id: action.id, mode, required: true });
      if (action.kind === 'entry') result.push({ id: `${action.id}-arrival`, mode, required: true });
      if (action.kind === 'search') result.push({ id: `${action.id}-known-positive`, mode, required: true });
    }
  }
  if ((contract.modes || JOURNEY_MODES).includes('cancel') && actions.some(action => action.kind === 'share')) result.push({ id: 'share-cancel', mode: 'cancel', required: true });
  return result;
}

function sanitizeRow(row, target, parents, now) {
  let recheck = (row.role !== undefined && !['guest', 'anonymous'].includes(row.role)) || row.layers?.business?.required === true || (row.discoveredFrom && !target.discoveredFrom);
  let checkedAt = iso(row.checkedAt);
  if (checkedAt && Date.parse(checkedAt) > now + 300000) checkedAt = null;
  const render = row.layers?.render || { status: row.status, checks: row.checks };
  const renderChecks = checks(render.checks);
  let renderStatus = canonicalStatus(render.status);
  if (renderStatus === 'pass' && (row.policy?.readOnly !== true || render.evidenceScope !== 'public-readonly' || !renderChecks.length || renderChecks.some(item => item.passed !== true))) recheck = true;
  const contract = contractFor(target);
  const definitions = expectedGuestCases(target);
  const expected = new Map(definitions.map(item => [item.id, item]));
  const sourceNavigation = row.layers?.navigation;
  const navigationCases = [];
  const seenCases = new Set();
  for (const item of Array.isArray(sourceNavigation?.cases) ? sourceNavigation.cases : []) {
    const definition = expected.get(item?.id);
    const caseViewport = definition?.mode === 'mobile' ? 'mobile' : target.viewport.name;
    if (!item || !definition || seenCases.has(item.id) || item.mode !== definition.mode || (item.role !== undefined && item.role !== 'guest') || item.viewport !== caseViewport) { recheck = true; continue; }
    seenCases.add(item.id);
    if (definition.required && item.required === false) recheck = true;
    const itemChecks = checks(item.checks);
    const itemStatus = canonicalStatus(item.status);
    if (itemStatus === 'pass' && (!itemChecks.length || itemChecks.some(check => check.passed !== true))) recheck = true;
    const layerClock = iso(sourceNavigation.checkedAt);
    const explicitClock = iso(item.checkedAt);
    let caseClock = explicitClock;
    if (item.checkedAt === undefined && ['pass', 'fail', 'blocked'].includes(itemStatus)) caseClock = layerClock || checkedAt;
    if (caseClock) caseClock = new Date(Math.min(...[caseClock, layerClock, checkedAt].filter(Boolean).map(Date.parse))).toISOString();
    if (itemStatus === 'pass' && (!caseClock || Date.parse(caseClock) > now + 300000 || (explicitClock && Date.parse(explicitClock) > now + 300000) || (layerClock && Date.parse(layerClock) > now + 300000) || (item.checkedAt != null && !explicitClock) || (sourceNavigation.checkedAt != null && !layerClock))) { recheck = true; caseClock = null; }
    navigationCases.push({ id: item.id, name: `공개 이동 검사 ${navigationCases.length + 1}`, required: definition.required, status: itemStatus, mode: item.mode, viewport: caseViewport, checkedAt: caseClock, checks: itemChecks, reason: reason(itemStatus) });
  }
  for (const definition of definitions.filter(item => item.required && !seenCases.has(item.id))) {
    recheck = true;
    navigationCases.push({ id: definition.id, name: `공개 이동 검사 ${navigationCases.length + 1}`, required: true, status: 'not-run', mode: definition.mode, viewport: definition.mode === 'mobile' ? 'mobile' : target.viewport.name, checkedAt: null, checks: [], reason: reason('not-run') });
  }
  let navigationStatus = sourceNavigation ? canonicalStatus(sourceNavigation.status) : 'unregistered';
  if (navigationCases.length) navigationStatus = aggregate([navigationStatus, ...navigationCases.filter(item => item.required).map(item => item.status)]);
  if (navigationStatus === 'pass' && (!contract || sourceNavigation?.evidenceScope !== 'public-instrumented' || !navigationCases.some(item => item.required))) recheck = true;
  const discoveredPages = [];
  for (const page of Array.isArray(row.discoveredPages) ? row.discoveredPages : []) {
    const url = publicTargetUrl(page?.url, { parentUrl: target.url, parents });
    if (!url || (page.discoveredFrom && page.discoveredFrom !== target.url)) { recheck = true; continue; }
    discoveredPages.push({ url, name: '공개 관람 화면', group: classify(url), discoveredFrom: target.url });
  }
  if (!checkedAt || recheck) {
    checkedAt = null;
    if (renderStatus === 'pass') renderStatus = 'not-run';
    if (navigationStatus === 'pass') navigationStatus = 'not-run';
    for (const item of navigationCases) if (item.status === 'pass') { item.status = 'not-run'; item.reason = reason(item.status); }
  }
  const status = aggregate([renderStatus, navigationStatus]);
  return {
    ...target, name: '공개 페이지 점검', group: classify(target.url), checkedAt,
    status: status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'unknown',
    layers: {
      render: { required: true, status: renderStatus, checkedAt, checks: renderChecks, evidenceScope: 'public-readonly', reason: reason(renderStatus) },
      navigation: { required: true, status: navigationStatus, checkedAt, cases: navigationCases, contractId: contract?.id || null, evidenceScope: 'public-instrumented', reason: reason(navigationStatus) },
      business: { required: false, status: 'not-run', cases: [], reason: '인증된 업무는 공개 재개 체크포인트에 저장하지 않습니다.' },
    },
    issues: [], checks: renderChecks, policy: { readOnly: true },
    ...(discoveredPages.length ? { discoveredPages } : {}),
  };
}

export function sanitizeCiState(source) {
  if (!source || source.schemaVersion !== 1 || !source.fingerprints || typeof source.fingerprints !== 'object' || Array.isArray(source.fingerprints)) throw new Error('공개 체크포인트의 CI 상태 형식이 올바르지 않습니다.');
  return {
    schemaVersion: 1,
    mode: source.mode === 'continuous' ? 'continuous' : 'after-deploy',
    fingerprints: Object.fromEntries(fingerprintUrls.filter(url => sha(source.fingerprints[url])).map(url => [url, source.fingerprints[url]])),
    watchUntil: iso(source.watchUntil), lastGateAt: iso(source.lastGateAt),
    reason: gateReasons.includes(source.reason) ? source.reason : 'outside-deploy-window',
    shouldRun: source.shouldRun === true, resetCycle: source.resetCycle === true,
    ...(sha(source.errorFingerprint) ? { errorFingerprint: source.errorFingerprint } : {}),
  };
}

export function sanitizeStatus(source, { now = Date.now() } = {}) {
  if (!source || !Array.isArray(source.results)) throw new Error('공개 체크포인트의 검사 상태 형식이 올바르지 않습니다.');
  const parents = new Set(source.results.filter(row => row?.policy?.readOnly === true && row.layers?.render?.evidenceScope === 'public-readonly' && row.layers?.business?.required !== true && (row.role === undefined || ['guest', 'anonymous'].includes(row.role))).map(row => envelope(row)).filter(Boolean).map(row => row.url));
  const seen = new Set();
  const counts = new Map();
  for (const row of source.results) if (row?.id) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  let omitted = false;
  const results = [];
  for (const row of source.results) {
    const target = envelope(row, { parents });
    if (!target || seen.has(target.id)) { omitted = true; continue; }
    seen.add(target.id);
    const safe = sanitizeRow(counts.get(target.id) > 1 ? { ...row, checkedAt: null } : row, target, parents, now);
    results.push(safe);
  }
  const runId = typeof source.runId === 'string' && /^run-\d{13}-[a-f0-9]{6}$/.test(source.runId) ? source.runId : null;
  const inventorySignature = sha(source.inventorySignature) ? source.inventorySignature : null;
  return {
    schemaVersion: 2, checkpointPolicy: policy,
    status: ['idle', 'completed', 'failed'].includes(source.status) ? source.status : 'failed',
    runId, inventorySignature, continuation: source.continuation === true && !!runId && !!inventorySignature,
    startedAt: iso(source.startedAt), attemptStartedAt: iso(source.attemptStartedAt), completedAt: iso(source.completedAt), nextRunAt: null,
    intervalMinutes: count(source.intervalMinutes) || 60, mode: source.mode === 'continuous' ? 'continuous' : 'after-deploy',
    discovery: { complete: source.discovery?.complete === true && !omitted, source: '공개 경로만 보관한 재개 체크포인트', totalTargets: Math.max(results.length, count(source.discovery?.totalTargets)), totalExhibitions: count(source.discovery?.totalExhibitions), errors: omitted || source.discovery?.errors?.length ? ['일부 경로 또는 상세 근거는 저장하지 않았습니다. 새 공개 수집에서 다시 확인합니다.'] : [] },
    results, history: [],
    businessVerification: { required: true, status: 'not-run', checkedAt: null, cases: [], reason: '인증된 업무 결과는 공개 재개 체크포인트에 저장하지 않습니다.' },
  };
}

function locations(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(root, 'data'));
  const checkpointDir = path.resolve(options.checkpointDir || path.join(root, '.monitor-checkpoint'));
  const source = path.resolve(root);
  if (checkpointDir === source || source.startsWith(checkpointDir + path.sep) || checkpointDir === dataDir || dataDir.startsWith(checkpointDir + path.sep) || checkpointDir.startsWith(dataDir + path.sep)) throw new Error('공개 체크포인트 폴더는 원본 코드 및 로컬 데이터와 분리해야 합니다.');
  return { dataDir, checkpointDir };
}

async function jsonFile(filename, optional = false) {
  try {
    if ((await stat(filename)).size > 32 * 1024 * 1024) throw new Error('상태 JSON이 허용된 크기를 초과했습니다.');
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new Error('체크포인트 상태 JSON을 읽지 못했습니다. 원문은 출력하지 않습니다.');
  }
}

function wrapped(data, kind, preparedAt, pairSha256) {
  return { metadata: { schemaVersion: 2, policy, kind, preparedAt, payloadSha256: digest(data), pairSha256 }, data };
}

function validatePair(ci, status) {
  const keys = value => Object.keys(value).sort().join(',');
  for (const [entry, kind] of [[ci, 'ci-state'], [status, 'status']]) {
    if (!entry || keys(entry) !== 'data,metadata' || !entry.metadata || keys(entry.metadata) !== 'kind,pairSha256,payloadSha256,policy,preparedAt,schemaVersion' || entry.metadata.schemaVersion !== 2 || entry.metadata.policy !== policy || entry.metadata.kind !== kind || iso(entry.metadata.preparedAt) !== entry.metadata.preparedAt || !sha(entry.metadata.payloadSha256) || entry.metadata.payloadSha256 !== digest(entry.data)) throw new Error('공개 체크포인트의 형식 또는 무결성을 확인하지 못했습니다. 복원하지 않습니다.');
  }
  const pair = digest([ci.data, status.data]);
  if (ci.metadata.preparedAt !== status.metadata.preparedAt || ci.metadata.pairSha256 !== pair || status.metadata.pairSha256 !== pair) throw new Error('서로 다른 실행의 체크포인트가 섞여 있습니다. 복원하지 않습니다.');
  if (JSON.stringify(sanitizeCiState(ci.data)) !== JSON.stringify(ci.data) || JSON.stringify(sanitizeStatus(status.data)) !== JSON.stringify(status.data)) throw new Error('공개 재개 체크포인트에 허용되지 않은 값이 있습니다. 복원하지 않습니다.');
}

export async function prepareCheckpoint(options = {}) {
  const { dataDir, checkpointDir } = locations(options);
  const ci = sanitizeCiState(await jsonFile(path.join(dataDir, files[0])));
  const status = sanitizeStatus(await jsonFile(path.join(dataDir, files[1]), true) || { status: 'failed', results: [] });
  const preparedAt = new Date().toISOString();
  const pair = digest([ci, status]);
  const entries = [wrapped(ci, 'ci-state', preparedAt, pair), wrapped(status, 'status', preparedAt, pair)];
  validatePair(...entries);
  // This resolved destination is a separate, generated checkpoint directory.
  await rm(checkpointDir, { recursive: true, force: true });
  await mkdir(checkpointDir, { recursive: true });
  for (let index = 0; index < files.length; index++) await writeFile(path.join(checkpointDir, files[index]), JSON.stringify(entries[index], null, 2) + '\n');
  console.log(`공개 재개 체크포인트 준비: ${status.results.length}개 공개 경로. 캡처·인증 업무·원문 로그는 저장하지 않습니다.`);
  return { ci, status };
}

export async function restoreCheckpoint(options = {}) {
  const { dataDir, checkpointDir } = locations(options);
  const entries = await readdir(checkpointDir, { withFileTypes: true });
  if (entries.length !== 2 || entries.some(entry => !entry.isFile() || !files.includes(entry.name))) throw new Error('공개 체크포인트에는 지정된 두 JSON 파일만 허용합니다. 복원하지 않습니다.');
  const ci = await jsonFile(path.join(checkpointDir, files[0]));
  const status = await jsonFile(path.join(checkpointDir, files[1]));
  validatePair(ci, status);
  try { await stat(path.join(dataDir, 'runner.lock')); throw new Error('실행 중인 로컬 점검 잠금이 있어 상태를 덮어쓰지 않습니다.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dataDir, { recursive: true });
  for (const [filename, data] of [[files[0], ci.data], [files[1], status.data]]) {
    const destination = path.join(dataDir, filename);
    await writeFile(destination + '.checkpoint.tmp', JSON.stringify(data, null, 2) + '\n');
    await rename(destination + '.checkpoint.tmp', destination);
  }
  console.log(`검증한 공개 체크포인트 복원: ${status.data.results.length}개 경로. 업무 검증은 새로 실행해야 합니다.`);
  return { ci: ci.data, status: status.data };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] === 'prepare' ? prepareCheckpoint : process.argv[2] === 'restore' ? restoreCheckpoint : null;
  if (!action) { console.error('Usage: node checkpoint.mjs prepare|restore'); process.exitCode = 2; }
  else await action().catch(error => { console.error(error.message); process.exitCode = 2; });
}
