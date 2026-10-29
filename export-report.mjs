import { cp, mkdir, readFile, readdir, rename, rm, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const iso = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const staticPaths = new Set(['/', '/home', '/en', '/home2', '/ai-art-exhibition', '/en/guides', '/tools/exhibition-poster', '/meum-service', '/plan', '/en/pricing', '/cases', '/sample-exhibition', '/school/teachers', '/school/teacher-guide', '/galleries', '/exhibition', '/customer-center/notice', '/customer-center/event', '/customer-center/qna', '/customer-center/contact', '/customer-center/certificated', '/en/get-started', '/en/team', '/webtoon', '/login', '/login/info', '/login/findPassword', '/login/findEmail', '/register']);
const groups = new Set(['공개 화면', '전시 프리뷰', '초대장', '전시 초대장', '3D 관람', '아카이브', '제작자', '웹툰']);
const issueLabels = {
  javascript: '브라우저 실행 오류가 발견됐습니다.', 'browser-crash': '브라우저 탭이 종료됐습니다.', network: '필수 공개 리소스 요청에 실패했습니다.', 'http-resource': '필수 공개 리소스가 오류 응답을 반환했습니다.', http: '정상 HTTP 응답을 확인하지 못했습니다.', redirect: '등록한 공개 목적지와 다른 화면으로 이동했습니다.', 'render-timeout': '화면 준비 조건을 제한 시간 안에 확인하지 못했습니다.', 'required-content': '필수 화면 요소를 확인하지 못했습니다.', '3d-not-ready': '3D 엔진의 준비 완료를 확인하지 못했습니다.', loading: '로딩이 끝나지 않았습니다.', 'error-screen': '오류 안내 화면이 발견됐습니다.', 'empty-dom': '페이지 본문이 비어 있습니다.', 'broken-image': '표시 이미지가 로드되지 않았습니다.', 'broken-background': '배경 이미지가 로드되지 않았습니다.', 'blank-screen': '화면 픽셀이 단색으로 표시됐습니다.', 'blank-canvas': '3D 캔버스에서 실제 장면을 확인하지 못했습니다.', 'capture-unavailable': '캡처를 얻지 못해 실제 화면 픽셀은 미확인입니다.', 'read-only-block': '공개 읽기 점검에서 쓰기 요청 또는 WebSocket을 차단했습니다.', 'access-required': '인증 또는 입장 안내로 실제 화면은 미확인입니다.', contract: '이 경로의 화면 검사 기준을 확인해야 합니다.', 'entry-discovery': '공개 관람 목적지를 확인하지 못했습니다.', navigation: '공개 페이지를 여는 중 오류가 발생했습니다.', 'not-checked': '이번 실행에서 브라우저 점검을 마치지 못했습니다.', runner: '점검기를 실행하지 못해 현재 상태가 미확인입니다.', monitor: '이번 실행의 새 점검 결과를 확인하지 못했습니다.', deployment: '새 배포 확인 후 다시 점검해야 합니다.'
};
const checkNames = new Set(['HTTP 응답', '브라우저 실행', '필수 화면 요소', '실제 화면 픽셀']);
const businessIds = ['viewer-settings-owner', 'viewer-settings-invited-admin', 'viewer-settings-readonly', 'auto-install', 'survey-target-included', 'survey-target-excluded', 'survey-submit-admin-read', 'payment-success-immediate', 'payment-success-scheduled', 'payment-failure-cancel', 'payment-duplicate-callback'];

function entryUrl(value, type, roomId, hash, family) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return null;
    if (type === 'viewers' && family === 'archive-viewer' && hash === null && url.origin === 'https://archive.meum.me' && url.pathname === `/archive/viewer/${roomId}` && !url.search) return url.href;
    if (url.origin !== 'https://meum.me' || family === 'archive-viewer') return null;
    if (type === 'previews' && url.pathname === `/exhibition/preview/${roomId}` && !url.search) return url.href;
    if (type === 'invitations' && url.pathname === `/exhibition/invitation/${hash}` && !url.search) return url.href;
    if (type === 'viewers' && url.pathname === '/meum-lite-viewer' && url.searchParams.size === 1 && url.searchParams.get('r') === hash) return url.href;
  } catch { /* Unregistered private URLs never enter a public summary. */ }
  return null;
}

export function publicSampling(source) {
  if (source?.schemaVersion !== 1 || source.mode !== 'representative-sample') return null;
  const sampling = { schemaVersion: 1, mode: 'representative-sample', selectedAt: iso(source.selectedAt), selectionId: /^[a-f0-9]{20}$/.test(source.selectionId || '') ? source.selectionId : null, seed: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(source.seed || '') ? source.seed : null, limits: {}, previews: [], invitations: [], viewers: [], unavailable: [], scope: '공개 일반 전시의 경로 유형별 대표 표본입니다. 전체 서비스·전시 전수 검사 결과가 아닙니다.', reason: '공개·진행 중·비인증 입장 조건을 확인한 전시에서 실행별 표본을 선택합니다.' };
  if (source.pool && typeof source.pool === 'object') sampling.pool = { listed: count(source.pool.listed), declared: Number.isSafeInteger(source.pool.declared) && source.pool.declared >= 0 ? source.pool.declared : null, pagesRead: count(source.pool.pagesRead), complete: source.pool.complete === true, bounded: source.pool.bounded === true, eligible: count(source.pool.eligible) };
  for (const key of ['previews', 'invitations', 'viewers', 'curatorFallback', 'maxRoomPages', 'maxCandidateChecks']) if (Number.isSafeInteger(source.limits?.[key]) && source.limits[key] >= 0 && source.limits[key] <= 1000) sampling.limits[key] = source.limits[key];
  for (const type of ['previews', 'invitations', 'viewers']) for (const row of (Array.isArray(source[type]) ? source[type] : []).slice(0, 3)) {
    const archive = type === 'viewers' && row.family === 'archive-viewer';
    if (!Number.isSafeInteger(row.roomId) || row.roomId < 1 || (archive ? row.hash !== null || row.reason !== 'active-public-archive' : !/^[a-zA-Z0-9_-]{1,128}$/.test(row.hash || ''))) continue;
    const url = entryUrl(row.url, type, row.roomId, row.hash, row.family);
    if (url) sampling[type].push({ roomId: row.roomId, hash: row.hash, ...(archive ? { family: 'archive-viewer' } : {}), url, eligible: row.eligible === true, reason: archive ? 'active-public-archive' : row.reason === 'verified-curator-fallback' ? 'verified-curator-fallback' : 'public-active-guest-open' });
  }
  for (const row of (Array.isArray(source.unavailable) ? source.unavailable : []).slice(0, 100)) if (['preview', 'invitation', 'viewer', 'selection'].includes(row.type)) sampling.unavailable.push({ type: row.type, ...(['archive-viewer', 'oneday-preview', 'oneday-viewer', 'sample-invitation'].includes(row.family) ? { family: row.family } : {}), ...(Number.isSafeInteger(row.roomId) && row.roomId > 0 ? { roomId: row.roomId } : {}), reason: ['route-family-not-verified', 'selected-room-no-longer-eligible', 'no-verified-eligible-sample', 'no-published-public-id-and-readonly-proof'].includes(row.reason) ? row.reason : 'public-selection-unavailable' });
  return sampling;
}

function publicUrl(raw, selected) {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.hash) return null;
    if (selected.has(url.href)) return url.href;
    if (!url.search && (url.origin === 'https://meum.me' && staticPaths.has(url.pathname) || url.origin === 'https://archive.meum.me' && ['/', '/archive'].includes(url.pathname))) return url.href;
  } catch { /* Omit arbitrary URLs rather than stripping credentials into a different target. */ }
  return null;
}

function anonymousFamily(row) {
  const known = ['creator', 'archive-owner', 'webtoon'];
  if (row.url === null && row.identityWithheld === true && known.includes(row.publicRouteFamily)) return row.publicRouteFamily;
  try {
    const url = new URL(row.url);
    if (url.search || url.hash || url.username || url.password) return null;
    if (url.origin === 'https://meum.me' && /^\/creator\/ws_[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) return 'creator';
    if (url.origin === 'https://meum.me' && /^\/webtoon\/[^/]+\/?$/.test(url.pathname)) return 'webtoon';
    if (url.origin === 'https://archive.meum.me' && /^\/archive\/[^/]+\/?$/.test(url.pathname)) return 'archive-owner';
  } catch { /* Neither a private URL nor an arbitrary null URL establishes a public family. */ }
  return null;
}

export function publicSummary(source) {
  const sampling = publicSampling(source.discovery?.sampling);
  const selected = new Set(['previews', 'invitations', 'viewers'].flatMap(type => sampling?.[type]?.filter(row => row.eligible).map(row => row.url) || []));
  let withheld = 0, identityWithheld = 0;
  const results = [];
  for (const row of source.results || []) {
    const url = publicUrl(row.url, selected);
    const family = !url ? anonymousFamily(row) : null;
    if ((!url && !family) || !/^[a-f0-9]{20}$/.test(row.id || '')) { withheld++; continue; }
    const group = family ? { creator: '제작자', 'archive-owner': '아카이브', webtoon: '웹툰' }[family] : groups.has(row.group) ? row.group : '공개 화면';
    if (family) identityWithheld++;
    results.push({ id: row.id, name: `${group} · ${row.id.slice(0, 8)}`, group, url, ...(family ? { publicRouteFamily: family, identityWithheld: true, identityWithheldReason: '공개 대표 경로의 식별자는 비공개로 보관하며 검사 판정은 유지합니다.' } : {}), status: ['pass', 'fail'].includes(row.status) && iso(row.checkedAt) ? row.status : row.status === 'pending' ? 'pending' : 'unknown', checkedAt: iso(row.checkedAt), durationMs: count(row.durationMs), httpStatus: Number.isSafeInteger(row.httpStatus) && row.httpStatus >= 100 && row.httpStatus <= 599 ? row.httpStatus : null, issues: (Array.isArray(row.issues) ? row.issues : []).slice(0, 30).map(issue => ({ kind: Object.hasOwn(issueLabels, issue?.kind) ? issue.kind : 'monitor', message: issueLabels[issue?.kind] || '점검 상세 내용은 비공개 로컬 보고서에 보관합니다.' })), checks: (Array.isArray(row.checks) ? row.checks : []).filter(check => checkNames.has(check.name)).map(check => ({ name: check.name, passed: check.passed === true ? true : check.passed === false ? false : null })), screenshot: null, screenshotOmittedReason: '공개 보고서에는 캡처와 고객 제목·관측 원문을 기본으로 게시하지 않습니다.' });
    if (row.policy?.readOnly === true) results.at(-1).policy = { readOnly: true, ...Object.fromEntries(['blockedServiceWrites', 'blockedServiceSockets', 'blockedExternalWrites', 'blockedExternalSockets', 'blockedMutatingReads'].map(key => [key, count(row.policy[key])])) };
  }
  const errors = (Array.isArray(source.discovery?.errors) ? source.discovery.errors : []).map(() => '공개 목록 수집 또는 점검을 완료하지 못했습니다. 실행 로그를 확인하세요.');
  if (!sampling) errors.push('대표 표본 선택 메타가 없어 점검 범위를 확인할 수 없습니다.');
  if (withheld) errors.push('공개 선택 목록에 등록되지 않은 결과를 게시에서 제외했습니다.');
  return { schemaVersion: 1, status: ['idle', 'running', 'completed', 'failed'].includes(source.status) ? source.status : 'failed', runId: /^run-\d+-[a-f0-9]{6}$/.test(source.runId || '') ? source.runId : null, inventorySignature: /^[a-f0-9]{64}$/.test(source.inventorySignature || '') ? source.inventorySignature : null, startedAt: iso(source.startedAt), attemptStartedAt: iso(source.attemptStartedAt), completedAt: iso(source.completedAt), intervalMinutes: Number.isFinite(source.intervalMinutes) && source.intervalMinutes > 0 ? source.intervalMinutes : 60, continuation: source.continuation === true, readOnly: true, sampling, discovery: { complete: source.discovery?.complete === true && !!sampling?.selectionId && !sampling.unavailable.length && !withheld, source: '공개 목록·비인증 입장 조건을 확인한 대표 표본', totalExhibitions: count(source.discovery?.totalExhibitions), totalTargets: Math.max(results.length + withheld, count(source.discovery?.totalTargets)), errors, sampling }, results, history: [], withheldResults: withheld, coverageOmittedResults: withheld, identityWithheldResults: identityWithheld, businessVerification: { required: true, status: 'blocked', checkedAt: null, reason: '실제 앱의 인증·저장·결제 업무는 실행하지 않았습니다. 승인된 실제 앱 adapter가 등록되지 않았습니다.', cases: businessIds.map(id => ({ id, status: 'blocked', evidenceScope: 'blocked', checkedAt: null })) } };
}

export function publicCiState(source) {
  if (source.schemaVersion !== 1) throw new Error('CI 상태 형식이 올바르지 않습니다.');
  const fingerprints = {};
  for (const url of ['https://meum.me/home', 'https://archive.meum.me/']) if (/^[a-f0-9]{64}$/.test(source.fingerprints?.[url] || '')) fingerprints[url] = source.fingerprints[url];
  const reasons = ['outside-deploy-window', 'inside-deploy-window', 'fingerprint-check-failed', 'first-run', 'deployment-dispatch', 'deployment-changed', 'manual-six-hours', 'manual-once', 'continuous'];
  return { schemaVersion: 1, mode: source.mode === 'continuous' ? 'continuous' : 'after-deploy', fingerprints, watchUntil: iso(source.watchUntil), lastGateAt: iso(source.lastGateAt), reason: reasons.includes(source.reason) ? source.reason : 'outside-deploy-window', shouldRun: source.shouldRun === true, resetCycle: source.resetCycle === true, errorFingerprint: /^[a-f0-9]{64}$/.test(source.errorFingerprint || '') ? source.errorFingerprint : null };
}

async function treeBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await treeBytes(filename);
    else if (entry.isFile()) bytes += (await lstat(filename)).size;
    else throw new Error('게시 폴더에는 일반 파일과 폴더만 허용합니다.');
  }
  return bytes;
}

export async function exportReport({ dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data')), siteDir = path.join(root, 'site'), workflowUrl = process.env.MONITOR_WORKFLOW_URL || '', scanStartedAt = process.env.MONITOR_SCAN_STARTED_AT, maxSiteBytes = 100 * 1024 * 1024, normalScreenshotLimit = 3, includeScreenshots = false, copyScreenshot = cp } = {}) {
  siteDir = path.resolve(siteDir); dataDir = path.resolve(dataDir);
  if (siteDir === path.parse(siteDir).root || siteDir === path.resolve(root) || path.resolve(root).startsWith(siteDir + path.sep) || siteDir === dataDir || dataDir.startsWith(siteDir + path.sep)) throw new Error('게시 폴더는 원본 코드 및 점검 데이터와 분리해야 합니다.');
  if (!Number.isSafeInteger(maxSiteBytes) || maxSiteBytes < 1 || !Number.isSafeInteger(normalScreenshotLimit) || normalScreenshotLimit < 0) throw new Error('게시 용량 설정이 올바르지 않습니다.');
  let source;
  try { source = JSON.parse(await readFile(path.join(dataDir, 'status.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; source = { status: 'failed', results: [], discovery: { complete: false, errors: ['missing'] } }; }
  if (!source || !Array.isArray(source.results)) throw new Error('점검 결과 JSON 형식이 올바르지 않습니다.');
  let ci;
  try { ci = publicCiState(JSON.parse(await readFile(path.join(dataDir, 'ci-state.json'), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; ci = publicCiState({ schemaVersion: 1 }); }
  const attemptTime = Date.parse(source.attemptStartedAt || source.startedAt);
  if (scanStartedAt && (!Number.isFinite(attemptTime) || attemptTime < Date.parse(scanStartedAt) - 5000)) {
    source.status = 'failed'; source.results = source.results.map(row => ({ ...row, status: 'unknown', issues: [...(row.issues || []), { kind: 'monitor' }] }));
    source.discovery = { ...source.discovery, complete: false, errors: [...(source.discovery?.errors || []), 'missing-new-scan'] };
  }
  if (source.status === 'running') { source.status = 'failed'; source.discovery = { ...source.discovery, complete: false, errors: [...(source.discovery?.errors || []), 'partial'] }; }
  const report = publicSummary(source);
  report.exportedAt = new Date().toISOString(); report.nextRunAt = null;
  try { const url = new URL(workflowUrl); if (url.origin === 'https://github.com' && !url.search && !url.hash && !url.username && !url.password) report.workflowUrl = url.href; } catch { /* Optional safe workflow link. */ }
  report.scheduleDescription = '매시간 배포 변경을 확인하며, 배포 후 6시간 동안 공개 대표 표본을 점검합니다. 예약 실행은 지연될 수 있습니다.';
  // The checked absolute destination is a generated site, never a parent of source/data.
  await rm(siteDir, { recursive: true, force: true });
  await mkdir(siteDir, { recursive: true });
  for (const filename of ['index.html', 'app.js', 'style.css']) await cp(path.join(root, 'public', filename), path.join(siteDir, filename));
  const indexFile = path.join(siteDir, 'index.html');
  const index = await readFile(indexFile, 'utf8');
  if (!index.includes('</head>')) throw new Error('대시보드 HTML에 head 닫는 태그가 없습니다.');
  await writeFile(indexFile, index.replace('</head>', '<meta name="monitor-report" content="./status.json" />\n</head>'));
  await writeFile(path.join(siteDir, '.nojekyll'), '');
  await writeFile(path.join(siteDir, '.monitor-ci.json'), JSON.stringify(ci, null, 2) + '\n');
  let copied = 0, omitted = 0, normalCopied = 0;
  let remaining = maxSiteBytes - await treeBytes(siteDir) - Buffer.byteLength(JSON.stringify(report)) - report.results.length * 1024 - 4096;
  const rawRows = new Map(source.results.map(row => [row.id, row]));
  for (const row of [...report.results].sort((a, b) => Number(a.status === 'pass') - Number(b.status === 'pass'))) {
    const raw = rawRows.get(row.id);
    if (!raw?.screenshot) continue;
    omitted++;
    if (!includeScreenshots || row.identityWithheld) continue;
    if (row.status === 'pass' && normalCopied >= normalScreenshotLimit) { row.screenshotOmittedReason = '정상 캡처의 대표 게시 수를 초과하여 생략했습니다.'; continue; }
    if (!/^\/screenshots\/run-\d+-[a-f0-9]{6}\/[a-f0-9]{20}\.png$/.test(raw.screenshot) || path.basename(raw.screenshot) !== `${row.id}.png`) { row.screenshotOmittedReason = '검증되지 않은 캡처 경로는 게시하지 않습니다.'; continue; }
    const sourceFile = path.resolve(dataDir, raw.screenshot.slice(1));
    const destination = path.resolve(siteDir, raw.screenshot.slice(1));
    if (!sourceFile.startsWith(path.resolve(dataDir, 'screenshots') + path.sep) || !destination.startsWith(path.resolve(siteDir, 'screenshots') + path.sep)) continue;
    try {
      const metadata = await lstat(sourceFile);
      if (!metadata.isFile() || metadata.size > remaining) { row.screenshotOmittedReason = '캡처 파일 형식 또는 게시 용량 제한으로 생략했습니다.'; continue; }
      await mkdir(path.dirname(destination), { recursive: true }); await copyScreenshot(sourceFile, destination);
      remaining -= metadata.size; copied++; omitted--; if (row.status === 'pass') normalCopied++;
      row.screenshot = raw.screenshot; delete row.screenshotOmittedReason;
    } catch {
      await rm(destination, { force: true }).catch(() => {});
      row.screenshotOmittedReason = '캡처 파일 복사·업로드 준비 실패로 생략했습니다. 페이지 검사 판정은 유지됩니다.';
    }
  }
  report.evidence = { copiedScreenshots: copied, omittedScreenshots: omitted, screenshotsPublic: includeScreenshots === true, maxSiteBytes };
  await writeFile(path.join(siteDir, 'status.json.tmp'), JSON.stringify(report, null, 2) + '\n');
  await rename(path.join(siteDir, 'status.json.tmp'), path.join(siteDir, 'status.json'));
  if (await treeBytes(siteDir) > maxSiteBytes) throw new Error('게시 폴더의 용량 제한을 초과했습니다.');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await exportReport().catch(error => { console.error(error.message); process.exitCode = 2; });
