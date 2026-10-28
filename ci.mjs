import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const stateFile = path.join(dataDir, 'ci-state.json');
const sixHours = 6 * 60 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');

async function readJson(file, optional = false) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

export function fingerprintParts(html, pageUrl) {
  const assets = new Set();
  const entries = new Set();
  const inline = [];
  const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    const script = match[1].toLowerCase() === 'script';
    const rel = attr(tag, 'rel') || '';
    if (!script && !/^(stylesheet|modulepreload|preload)$/i.test(rel)) continue;
    const raw = attr(tag, script ? 'src' : 'href');
    if (!raw) continue;
    const url = new URL(raw.replaceAll('&amp;', '&'), pageUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('허용되지 않은 배포 자산 URL');
    assets.add(url.href);
    if (script && url.origin === new URL(pageUrl).origin) entries.add(url.href);
  }
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const type = attr(match[1], 'type');
    if (type === 'module' || type === 'importmap') inline.push(match[2].trim());
    if (type === 'importmap') {
      const map = JSON.parse(match[2]);
      for (const value of Object.values(map.imports || {})) if (typeof value === 'string') assets.add(new URL(value, pageUrl).href);
    }
  }
  if (!assets.size && !inline.length) throw new Error('HTML에서 배포 자산을 확인할 수 없습니다.');
  return { assets: [...assets].sort(), entries: [...entries].sort(), inline };
}

export async function fingerprint(url, fetcher = fetch) {
  const pageUrl = new URL(url);
  if (!['https:', 'http:'].includes(pageUrl.protocol) || pageUrl.username || pageUrl.password) throw new Error('배포 확인 URL은 인증 정보 없는 HTTP(S) 주소여야 합니다.');
  const get = async target => {
    const response = await fetcher(target, { signal: AbortSignal.timeout(20_000), redirect: 'error', headers: { 'cache-control': 'no-cache' } });
    if (!response.ok) throw new Error(`배포 확인 HTTP ${response.status}: ${new URL(target).origin}${new URL(target).pathname}`);
    return response.text();
  };
  const html = await get(pageUrl.href);
  const parts = fingerprintParts(html, pageUrl.href);
  if (parts.entries.length > 12) throw new Error('배포 진입 스크립트가 12개를 넘습니다. 확인 범위를 조정해 주세요.');
  const entryHashes = [];
  for (const entry of parts.entries) entryHashes.push([entry, hash(await get(entry))]);
  const linkedMetadata = [];
  const ownAssets = parts.assets.filter(asset => new URL(asset).origin === pageUrl.origin && !parts.entries.includes(asset));
  if (ownAssets.length > 64) throw new Error('배포 연결 자산이 64개를 넘습니다. 확인 범위를 조정해 주세요.');
  for (const asset of ownAssets) {
    const response = await fetcher(asset, { method: 'HEAD', signal: AbortSignal.timeout(20_000), redirect: 'error', headers: { 'cache-control': 'no-cache' } });
    linkedMetadata.push([asset, response.status || 200, response.headers?.get('etag') || '', response.headers?.get('last-modified') || '', response.headers?.get('content-length') || '']);
  }
  return hash(JSON.stringify({ assets: parts.assets, inline: parts.inline, entryHashes, linkedMetadata }));
}

export function decideGate({ previous, fingerprints, errors = [], mode = 'after-deploy', eventName, manualMode, now = Date.now() }) {
  if (!['continuous', 'after-deploy'].includes(mode)) throw new Error('MONITOR_MODE는 continuous 또는 after-deploy여야 합니다.');
  if (previous && (previous.schemaVersion !== 1 || !previous.fingerprints || typeof previous.fingerprints !== 'object' || Array.isArray(previous.fingerprints) || (previous.watchUntil && !Number.isFinite(Date.parse(previous.watchUntil))))) throw new Error('이전 CI 상태 파일이 손상됐습니다. 상태를 초기화하지 않고 중단합니다.');
  const first = previous === null;
  const changed = !first && Object.entries(fingerprints).some(([url, value]) => previous.fingerprints[url] !== value);
  const deployed = eventName === 'repository_dispatch';
  const manual = eventName === 'workflow_dispatch';
  const newFailure = errors.length > 0 && JSON.stringify(errors) !== JSON.stringify(previous?.errors || []);
  let watchUntil = previous?.watchUntil || null;
  let reason = 'outside-deploy-window';
  if (first || changed || deployed || (manual && manualMode === 'burst6h') || newFailure) {
    watchUntil = new Date(now + sixHours).toISOString();
    reason = errors.length ? 'fingerprint-check-failed' : first ? 'first-run' : deployed ? 'deployment-dispatch' : changed ? 'deployment-changed' : 'manual-six-hours';
  }
  const active = Number.isFinite(Date.parse(watchUntil)) && Date.parse(watchUntil) > now;
  const shouldRun = mode === 'continuous' || active || manual;
  if (mode === 'continuous') reason = 'continuous';
  else if (manual && manualMode === 'once' && !['first-run', 'deployment-changed', 'fingerprint-check-failed'].includes(reason)) reason = 'manual-once';
  else if (active && reason === 'outside-deploy-window') reason = 'inside-deploy-window';
  return {
    schemaVersion: 1,
    mode,
    fingerprints: errors.length ? { ...(previous?.fingerprints || {}), ...fingerprints } : fingerprints,
    watchUntil,
    lastGateAt: new Date(now).toISOString(),
    reason,
    shouldRun,
    resetCycle: first || changed || deployed || errors.length > 0,
    errors,
  };
}

export function invalidateCycle(report, gateState) {
  if (!report || !gateState.resetCycle) return report;
  if (!Array.isArray(report.results)) throw new Error('기존 점검 결과가 손상됐습니다. 새 배포 점검을 시작할 수 없습니다.');
  const message = gateState.errors.length ? '배포 지문을 확인하지 못해 이전 정상 판정을 해제했습니다. 새 브라우저 점검이 필요합니다.' : '새 배포가 감지되어 이전 점검 결과를 재사용하지 않습니다. 다시 점검합니다.';
  return {
    ...report,
    continuation: false,
    status: 'idle',
    completedAt: null,
    results: report.results.map(result => ({ ...result, status: 'unknown', issues: [...(result.issues || []), { kind: 'deployment', message }] })),
    discovery: { ...report.discovery, complete: false },
  };
}

async function gate() {
  if (process.env.CI === 'true' && !['none', 'restored'].includes(process.env.MONITOR_STATE_RESTORE)) throw new Error('이전 상태 복원 결과가 없습니다. 상태를 초기화하지 않고 중단합니다.');
  const previous = await readJson(stateFile, true);
  if (process.env.MONITOR_STATE_RESTORE === 'restored' && !previous) throw new Error('복원된 캐시에 ci-state.json이 없습니다.');
  const config = await readJson(path.join(root, 'config.json'));
  const urls = config.fingerprintUrls || ['https://meum.me/home', 'https://archive.meum.me/'];
  if (!Array.isArray(urls) || !urls.length) throw new Error('fingerprintUrls가 비어 있습니다.');
  const fingerprints = {};
  const errors = [];
  for (const url of urls) {
    try { fingerprints[url] = await fingerprint(url); }
    catch (error) { errors.push(error.message); }
  }
  const next = decideGate({ previous, fingerprints, errors, mode: process.env.MONITOR_MODE || 'after-deploy', eventName: process.env.GITHUB_EVENT_NAME, manualMode: process.env.MONITOR_MANUAL_MODE || 'once' });
  await mkdir(dataDir, { recursive: true });
  if (next.resetCycle) {
    const reportFile = path.join(dataDir, 'status.json');
    const report = await readJson(reportFile, true);
    if (report) {
      await writeFile(reportFile + '.tmp', JSON.stringify(invalidateCycle(report, next), null, 2) + '\n');
      await rename(reportFile + '.tmp', reportFile);
    }
  }
  await writeFile(stateFile + '.tmp', JSON.stringify(next, null, 2) + '\n');
  await rename(stateFile + '.tmp', stateFile);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `should_run=${next.shouldRun}\nreason=${next.reason}\nwatch_until=${next.watchUntil || ''}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## 렌더링 점검 실행 판단\n\n- 모드: ${next.mode}\n- 브라우저 점검: ${next.shouldRun ? '이번 실행에서 진행' : '배포 후 점검 시간 밖이므로 생략'}\n- 이유: ${next.reason}\n- 배포 후 점검 종료: ${next.watchUntil || '없음'}\n${errors.length ? '\n배포 지문 조회 오류가 있어 브라우저 점검으로 확인합니다.\n' : ''}`);
  console.log(JSON.stringify({ shouldRun: next.shouldRun, reason: next.reason, watchUntil: next.watchUntil, fingerprintErrors: errors.length }));
}

async function summarize() {
  const report = await readJson(path.join(root, 'site', 'status.json'), true) || await readJson(path.join(dataDir, 'status.json'), true);
  const exitCode = process.env.MONITOR_SCAN_EXIT_CODE;
  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const row of report?.results || []) counts[['pass', 'fail'].includes(row.status) ? row.status : 'unknown']++;
  const message = [
    '## 브라우저 점검 결과', '',
    `- 검사 프로세스 종료 코드: ${exitCode ?? '미실행'}`,
    `- 정상 ${counts.pass} / 문제 ${counts.fail} / 미확인 ${counts.unknown}`,
    `- 공개 목록 완전성: ${report?.discovery?.complete === true ? '확인됨' : '미확인'}`,
    `- 완료 시각: ${report?.completedAt || '완료되지 않음'}`,
    process.env.MONITOR_PAGES_URL ? `- GitHub Pages 대시보드: ${process.env.MONITOR_PAGES_URL}` : '- GitHub Pages 배포가 완료되지 않았습니다. 이번 실행의 검사 로그를 확인해 주세요.', '',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message);
  else console.log(message);
}

async function selfTest() {
  const { default: assert } = await import('node:assert/strict');
  const now = Date.parse('2026-10-28T00:00:00Z');
  const initial = decideGate({ previous: null, fingerprints: { a: 'one' }, now });
  assert.equal(initial.shouldRun, true);
  assert.equal(Date.parse(initial.watchUntil), now + sixHours);
  const expired = { ...initial, watchUntil: new Date(now - 1).toISOString() };
  assert.equal(decideGate({ previous: expired, fingerprints: { a: 'one' }, now }).shouldRun, false);
  assert.equal(decideGate({ previous: expired, fingerprints: { a: 'two' }, now }).shouldRun, true);
  assert.equal(decideGate({ previous: expired, fingerprints: { a: 'one' }, now, eventName: 'repository_dispatch' }).shouldRun, true);
  assert.equal(decideGate({ previous: expired, fingerprints: { a: 'one' }, now, eventName: 'workflow_dispatch', manualMode: 'once' }).watchUntil, expired.watchUntil);
  assert.equal(decideGate({ previous: expired, fingerprints: { a: 'one' }, now, eventName: 'workflow_dispatch', manualMode: 'burst6h' }).shouldRun, true);
  assert.equal(decideGate({ previous: expired, fingerprints: {}, errors: ['offline'], now }).shouldRun, true);
  assert.equal(decideGate({ previous: expired, fingerprints: { a: 'one' }, now, mode: 'continuous' }).shouldRun, true);
  const unchanged = decideGate({ previous: expired, fingerprints: { a: 'one' }, now });
  const changed = decideGate({ previous: expired, fingerprints: { a: 'two' }, now });
  const partial = { continuation: true, status: 'failed', results: [{ id: 'old-pass', status: 'pass' }], discovery: { complete: true } };
  assert.equal(unchanged.resetCycle, false);
  assert.equal(invalidateCycle(partial, unchanged), partial);
  const invalidated = invalidateCycle(partial, changed);
  assert.equal(invalidated.continuation, false);
  assert.equal(invalidated.results[0].status, 'unknown');
  assert.equal(invalidated.discovery.complete, false);
  assert.equal(partial.results[0].status, 'pass');
  assert.equal(invalidateCycle(partial, decideGate({ previous: expired, fingerprints: {}, errors: ['offline'], now })).results[0].status, 'unknown');
  assert.throws(() => decideGate({ previous: {}, fingerprints: {}, now }), /손상/);
  const html = '<script type="module" crossorigin src="/assets/main.abc.js"></script><link rel="stylesheet" href="/assets/main.abc.css"><script type="importmap">{"imports":{}}</script>';
  const parts = fingerprintParts(html, 'https://meum.me/home');
  assert.deepEqual(parts.entries, ['https://meum.me/assets/main.abc.js']);
  assert.equal(parts.assets.length, 2);
  assert.equal(parts.inline.length, 2);
  const a = await fingerprint('https://meum.me/home', async url => ({ ok: true, text: async () => url.endsWith('/home') ? html : 'code-a' }));
  const b = await fingerprint('https://meum.me/home', async url => ({ ok: true, text: async () => url.endsWith('/home') ? html : 'code-b' }));
  assert.notEqual(a, b);
  const mapHtml = html.replace('{"imports":{}}', '{"imports":{"preview":"/shared/preview.js"}}');
  const mock = version => async (url, options) => ({ ok: true, status: 200, text: async () => url.endsWith('/home') ? mapHtml : 'unchanged entry', headers: { get: key => options?.method === 'HEAD' && key === 'etag' ? version : '' } });
  assert.notEqual(await fingerprint('https://meum.me/home', mock('shared-v1')), await fingerprint('https://meum.me/home', mock('shared-v2')));
  const outage = decideGate({ previous: expired, fingerprints: {}, errors: ['offline'], now });
  const repeated = decideGate({ previous: { ...outage, watchUntil: new Date(now - 1).toISOString() }, fingerprints: {}, errors: ['offline'], now });
  assert.equal(repeated.shouldRun, false, 'unchanged outage must not reopen the six-hour window indefinitely');
  console.log('CI self-check passed: execution window, deployment detection, manual/dispatch modes, corrupt state, content fingerprint, continuation invalidation and stale pass removal.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  const run = action === 'gate' ? gate : action === 'summary' ? summarize : action === 'self-test' ? selfTest : null;
  if (!run) { console.error('Usage: node ci.mjs gate|summary|self-test'); process.exitCode = 2; }
  else await run().catch(error => { console.error(error.message); process.exitCode = 2; });
}
