import http from 'node:http';
import { readFile, writeFile, mkdir, rename, open, unlink, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { classify, discover } from './discovery.mjs';
import { launchBrowser, probe, safeMessage } from './probe.mjs';
import { fingerprint as publicFingerprint } from './ci.mjs';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const iso = () => new Date().toISOString();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function saveJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, filename);
}

export async function loadConfig() {
  const config = JSON.parse(await readFile(path.resolve(process.env.CONFIG_PATH || path.join(ROOT, 'config.json')), 'utf8'));
  if (process.env.RETAINED_RUNS) config.retainedRuns = Number(process.env.RETAINED_RUNS);
  for (const key of ['navigationTimeoutMs', 'renderTimeoutMs', 'settleMs', 'betweenPagesMs', 'maxSitemaps', 'maxRoomPages', 'retainedRuns']) if (!Number.isFinite(config[key]) || config[key] < (['settleMs', 'betweenPagesMs'].includes(key) ? 0 : 1)) throw new Error(`잘못된 설정: ${key}`);
  if (!Array.isArray(config.origins) || !config.origins.length || !config.viewports?.length) throw new Error('origins/viewports 설정이 필요합니다.');
  return config;
}

export function emptyState() {
  return { schemaVersion: 1, status: 'idle', runId: null, startedAt: null, completedAt: null, nextRunAt: null, intervalMinutes: Number(process.env.INTERVAL_MINUTES || 60), mode: process.env.MONITOR_MODE || 'continuous', discovery: { complete: false, source: null, totalExhibitions: 0, totalTargets: 0, errors: [] }, results: [], history: [] };
}

export async function readState() {
  try { return JSON.parse(await readFile(path.join(DATA, 'status.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return emptyState(); }
}

async function retainRuns(keep) {
  const base = path.join(DATA, 'screenshots');
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const runs = entries.filter(x => x.isDirectory() && /^run-\d+-[a-f0-9]{6}$/.test(x.name)).map(x => x.name).sort().reverse();
  for (const name of runs.slice(keep)) {
    const target = path.resolve(base, name);
    if (!target.startsWith(path.resolve(base) + path.sep)) throw new Error('보존 경로 검증 실패');
    await rm(target, { recursive: true, force: true });
  }
}

export async function runScan(config, state, persist, { stopAt = Infinity, signal } = {}) {
  const previous = state.continuation ? structuredClone(state) : null;
  state.runId = previous?.runId || `run-${Date.now()}-${randomBytes(3).toString('hex')}`;
  state.status = 'running'; state.startedAt = previous?.startedAt || iso(); state.completedAt = null; state.nextRunAt = null; state.continuation = false;
  state.attemptStartedAt = iso();
  state.results = []; state.discovery = { complete: false, source: null, totalExhibitions: 0, totalTargets: 0, errors: [] };
  await persist();
  let browser;
  const cancel = () => { void browser?.close().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const inventory = await discover(config, fetch, { sampling: previous?.discovery?.sampling });
    state.discovery = { ...inventory, pages: undefined, totalTargets: inventory.pages.length * config.viewports.length };
    state.results = inventory.pages.flatMap(page => config.viewports.map(viewport => ({ ...page, id: createHash('sha256').update(page.url + viewport.name).digest('hex').slice(0, 20), viewport, name: `${page.name}${config.viewports.length > 1 ? ` · ${viewport.name}` : ''}`, status: 'pending', checkedAt: null, issues: [], checks: [] })));
    const definitions = await Promise.all(['contracts.mjs', 'probe.mjs', 'discovery.mjs', 'sampling.mjs', 'read-only-policy.mjs', 'server.mjs', 'package-lock.json'].map(name => readFile(path.join(ROOT, name), 'utf8')));
    const signature = createHash('sha256').update(JSON.stringify([config, state.results.map(x => x.id).sort(), definitions])).digest('hex');
    if (previous?.inventorySignature === signature) {
      const known = new Map(previous.results.map(x => [x.id, x]));
      state.results = state.results.map(row => {
        const cached = known.get(row.id);
        if (!cached?.checkedAt || !Number.isFinite(Date.parse(cached.checkedAt))) return row;
        // Public checkpoints omit target details; use freshly validated URL/rule/viewport.
        return { ...cached, ...row, status: cached.status, checkedAt: cached.checkedAt, issues: cached.issues || [], checks: cached.checks || [], durationMs: cached.durationMs, httpStatus: cached.httpStatus, screenshot: null };
      });
      const sources = new Set(inventory.pages.map(x => x.url));
      const ids = new Set(state.results.map(x => x.id));
      if (!config.sampling?.enabled) state.results.push(...previous.results.filter(x => x.discoveredFrom && sources.has(x.discoveredFrom) && !ids.has(x.id)).map(x => x.checkedAt ? x : { ...x, status: 'pending', issues: [] }));
    } else if (previous) { state.runId = `run-${Date.now()}-${randomBytes(3).toString('hex')}`; state.startedAt = iso(); }
    state.inventorySignature = signature;
    await persist();
    if (signal?.aborted) throw new Error('점검 프로그램이 종료됐습니다.');
    browser = await launchBrowser();
    const limit = process.env.SCAN_LIMIT ? Number(process.env.SCAN_LIMIT) : Infinity;
    if (!Number.isInteger(limit) && limit !== Infinity || limit < 1) throw new Error('SCAN_LIMIT은 양의 정수여야 합니다.');
    const budget = process.env.SCAN_MAX_MINUTES ? Number(process.env.SCAN_MAX_MINUTES) * 60000 : Infinity;
    if (!(budget > 0)) throw new Error('SCAN_MAX_MINUTES는 양수여야 합니다.');
    const deadline = Math.min(stopAt, Date.now() + budget);
    let processed = 0;
    for (let index = 0; index < state.results.length; index++) {
      if (state.results[index].checkedAt) continue;
      if (processed >= limit || Date.now() >= deadline || signal?.aborted) {
        state.continuation = true;
        state.discovery.errors.push(processed >= limit ? `검증용 SCAN_LIMIT=${limit}: 나머지 페이지는 미확인입니다.` : '점검 시간 범위가 끝나 나머지 페이지는 미확인입니다.');
        for (const row of state.results.slice(index)) if (!row.checkedAt) { row.status = 'unknown'; row.issues = [{ kind: 'not-checked', message: '이번 실행에서 브라우저 검사를 마치지 못했습니다. 다음 실행에서 이어갑니다.' }]; }
        break;
      }
      state.results[index] = await probe(browser, state.results[index], config, path.join(DATA, 'screenshots', state.runId));
      for (const page of config.sampling?.enabled ? [] : state.results[index].discoveredPages || []) {
        for (const viewport of config.viewports) {
          const id = createHash('sha256').update(page.url + viewport.name).digest('hex').slice(0, 20);
          if (!state.results.some(row => row.id === id)) state.results.push({ ...page, id, viewport, status: 'pending', checkedAt: null, issues: [], checks: [] });
        }
      }
      state.discovery.totalTargets = state.results.length;
      processed++;
      await persist();
      console.log(`[${index + 1}/${state.results.length}] ${state.results[index].status} ${classify(state.results[index].url)} ${state.results[index].id}`);
      if (config.betweenPagesMs) await delay(config.betweenPagesMs);
    }
    state.status = 'completed';
  } catch (error) {
    state.status = 'failed'; state.discovery.errors.push(`점검기 실행 오류: ${safeMessage(error.message)}`);
    for (const row of state.results) if (row.status === 'pending') { row.status = 'unknown'; row.issues = [{ kind: 'runner', message: '점검기를 실행하지 못해 현재 상태를 확인할 수 없습니다.' }]; }
  } finally {
    signal?.removeEventListener('abort', cancel);
    await browser?.close().catch(() => {});
    state.completedAt = iso();
    const counts = { pass: 0, fail: 0, unknown: 0 };
    for (const row of state.results) counts[row.status === 'pass' ? 'pass' : row.status === 'fail' ? 'fail' : 'unknown']++;
    state.history = [...(state.history || []), { runId: state.runId, completedAt: state.completedAt, ...counts, total: state.results.length, complete: state.discovery.complete && counts.unknown === 0, scope: config.sampling?.enabled ? 'representative-render-only' : 'legacy-render-only' }].slice(-config.retainedRuns);
    await persist();
    await retainRuns(config.retainedRuns);
  }
  return state;
}

export async function deploymentFingerprint(config) {
  const values = [];
  for (const url of config.fingerprintUrls || ['https://meum.me/home', 'https://archive.meum.me/']) values.push([url, await publicFingerprint(url)]);
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

export function createMonitorServer(state, startScan) {
  const user = process.env.MONITOR_USER;
  const password = process.env.MONITOR_PASSWORD;
  const digest = text => createHash('sha256').update(text).digest();
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if (user && password) {
        const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
        if (!timingSafeEqual(digest(req.headers.authorization || ''), digest(expected))) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="MEUM Monitor"' }); res.end('Authentication required'); return; }
      }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/status' && req.method === 'GET') return json(res, 200, state);
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { runner: 'ok', lastCompletedAt: state.completedAt, status: state.status });
      if (url.pathname === '/api/run' && req.method === 'POST') {
        if (req.headers.origin) {
          let sameOrigin = false;
          try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch {}
          if (!sameOrigin) return json(res, 403, { error: '다른 사이트에서는 점검을 시작할 수 없습니다.' });
        }
        if (state.status === 'running') return json(res, 409, { error: '이미 점검 중입니다.' });
        startScan(); return json(res, 202, { started: true });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      let filename, type;
      if (files[url.pathname]) { [filename, type] = files[url.pathname]; filename = path.join(ROOT, 'public', filename); }
      else if (/^\/screenshots\/run-\d+-[a-f0-9]{6}\/[a-f0-9]{20}\.png$/.test(url.pathname)) { filename = path.join(DATA, url.pathname.slice(1)); type = 'image/png'; }
      else return json(res, 404, { error: 'Not found' });
      const body = await readFile(filename);
      res.writeHead(200, { 'Content-Type': `${type}${type === 'image/png' ? '' : '; charset=utf-8'}`, 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) { json(res, error.code === 'ENOENT' ? 404 : 500, { error: error.code === 'ENOENT' ? '파일이 없습니다.' : '점검 서버 요청 처리 오류' }); }
  });
}

async function main() {
  const config = await loadConfig();
  await mkdir(DATA, { recursive: true });
  const lockPath = path.join(DATA, 'runner.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('점검 잠금이 있습니다. 실행 중인 점검기를 확인하세요. 비정상 종료된 경우 README의 잠금 복구 절차를 따르세요.');
  }
  await lock.writeFile(String(process.pid)); await lock.close();
  const unlock = () => unlink(lockPath).catch(() => {});
  const state = await readState();
  if (state.status === 'running') { state.status = 'failed'; state.completedAt = iso(); state.continuation = true; for (const row of state.results) if (row.status === 'pending') row.status = 'unknown'; await saveJson(path.join(DATA, 'status.json'), state); }
  state.mode = process.env.MONITOR_MODE || 'continuous';
  state.intervalMinutes = Number(process.env.INTERVAL_MINUTES || (state.mode === 'after-deploy' ? 30 : 60));
  if (!['continuous', 'after-deploy'].includes(state.mode) || !Number.isFinite(state.intervalMinutes) || state.intervalMinutes < 1) throw new Error('MONITOR_MODE/INTERVAL_MINUTES 설정 오류');
  const persist = () => saveJson(path.join(DATA, 'status.json'), state);
  if (process.argv.includes('--once')) {
    try {
      const stopAt = process.env.MONITOR_STOP_AT && state.mode === 'after-deploy' ? Date.parse(process.env.MONITOR_STOP_AT) : Infinity;
      if (Number.isNaN(stopAt)) throw new Error('MONITOR_STOP_AT 시각이 올바르지 않습니다.');
      await runScan(config, state, persist, { stopAt });
      process.exitCode = state.status === 'failed' || !state.discovery.complete || state.results.some(x => x.status === 'unknown') ? 2 : state.results.some(x => x.status === 'fail') ? 1 : 0;
    } finally { await unlock(); }
    return;
  }
  let busy = false;
  const burstMs = Number(process.env.BURST_HOURS || 6) * 3600000;
  if (!Number.isFinite(burstMs) || burstMs <= 0) throw new Error('BURST_HOURS는 양수여야 합니다.');
  let currentRun;
  const controller = new AbortController();
  let activeUntil = state.mode === 'continuous' ? Infinity : Date.now() + burstMs;
  let fingerprint;
  const startScan = () => {
    if (busy) return;
    busy = true;
    if (state.mode === 'after-deploy' && Date.now() >= activeUntil) activeUntil = Date.now() + burstMs;
    state.activeUntil = Number.isFinite(activeUntil) ? new Date(activeUntil).toISOString() : null;
    currentRun = runScan(config, state, persist, { stopAt: activeUntil, signal: controller.signal }).finally(async () => {
      state.nextRunAt = Date.now() + state.intervalMinutes * 60000 < activeUntil ? new Date(Date.now() + state.intervalMinutes * 60000).toISOString() : null;
      busy = false; await persist();
    }).catch(e => console.error(safeMessage(e.message)));
  };
  const host = process.env.HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !(process.env.MONITOR_USER && process.env.MONITOR_PASSWORD) && process.env.TRUST_AUTH_PROXY !== '1') throw new Error('외부 주소로 열 때는 인증 또는 인증 프록시를 설정하세요.');
  const server = createMonitorServer(state, startScan);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.PORT || 8310), host, resolve); });
  console.log(`MEUM Monitor: http://${host}:${server.address().port} (${state.mode})`);
  let watcherBusy = false;
  const timer = setInterval(async () => {
    if (watcherBusy) return;
    watcherBusy = true;
    try {
      if (state.mode === 'after-deploy') {
        const next = await deploymentFingerprint(config);
        if (fingerprint && next !== fingerprint) { activeUntil = Date.now() + burstMs; state.nextRunAt = iso(); state.continuation = false; }
        fingerprint = next; state.watcherError = null;
      }
      if (!busy && Date.now() < activeUntil && state.nextRunAt && Date.now() >= Date.parse(state.nextRunAt)) startScan();
    } catch (e) { state.watcherError = safeMessage(e.message); await persist(); }
    finally { watcherBusy = false; }
  }, 60000);
  const shutdown = async () => { clearInterval(timer); server.close(); controller.abort(); await currentRun?.catch(() => {}); await unlock(); process.exit(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  startScan();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(safeMessage(error.message)); process.exitCode = 2; });
