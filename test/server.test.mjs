import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let directory;
let monitor;
const original = Object.fromEntries(['DATA_DIR', 'CONFIG_PATH', 'MONITOR_USER', 'MONITOR_PASSWORD'].map(key => [key, process.env[key]]));
const servers = [];

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'meum-monitor-server-test-'));
  process.env.DATA_DIR = directory;
  delete process.env.MONITOR_USER;
  delete process.env.MONITOR_PASSWORD;
  monitor = await import('../server.mjs');
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (directory) {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('meum-monitor-server-test-'));
    await rm(resolved, { recursive: true, force: true });
  }
});

async function fixture({ credentials = false, state = monitor.emptyState() } = {}) {
  if (credentials) {
    process.env.MONITOR_USER = 'fixture-user';
    process.env.MONITOR_PASSWORD = 'fixture-password';
  } else {
    delete process.env.MONITOR_USER;
    delete process.env.MONITOR_PASSWORD;
  }
  let starts = 0;
  const server = monitor.createMonitorServer(state, () => { starts++; state.status = 'running'; });
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    state, starts: () => starts, origin: `http://127.0.0.1:${port}`,
    send: (pathname, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: pathname, method, headers }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject); req.end();
    }),
  };
}

test('fresh state starts unverified and atomic persistence replaces JSON without temporary leftovers', async () => {
  const state = await monitor.readState();
  assert.equal(state.discovery.complete, false);
  assert.deepEqual(state.results, []);
  const filename = path.join(directory, 'nested', 'fixture.json');
  await monitor.saveJson(filename, { status: 'running', results: [{ status: 'pending' }] });
  await monitor.saveJson(filename, { status: 'failed', results: [{ status: 'unknown' }] });
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { status: 'failed', results: [{ status: 'unknown' }] });
  assert.deepEqual(await readdir(path.dirname(filename)), ['fixture.json']);
});

test('status returns actual pending/unknown state, and health identifies the runner', async () => {
  const state = monitor.emptyState();
  state.status = 'running'; state.results = [{ id: 'fixture', status: 'unknown' }];
  const server = await fixture({ state });
  const status = await server.send('/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(status.text).results, state.results);
  const health = await server.send('/api/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.text).runner, 'ok');
});

test('serves dashboard assets with CSP and HEAD without a response body', async () => {
  const server = await fixture();
  const page = await server.send('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.match(page.text, /<!doctype html>/i);
  const head = await server.send('/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.match(head.headers['content-type'], /javascript/);
  const css = await server.send('/style.css');
  assert.equal(css.status, 200);
});

test('static allowlist rejects secret files and raw/encoded traversal paths', async () => {
  const server = await fixture();
  for (const pathname of ['/.env', '/server.mjs', '/api/../status.json', '/%2e%2e/.env', '/screenshots/run-123-abcdef/../../status.json', '/screenshots/run-123-abcdef/%2e%2e/%2e%2e/.env']) {
    const response = await server.send(pathname);
    assert.equal(response.status, 404, pathname);
    assert.doesNotMatch(response.text, /fixture-password/);
  }
});

test('serves only strictly named screenshot artifacts and returns missing artifacts as 404', async () => {
  const folder = path.join(directory, 'screenshots', 'run-123-abcdef');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, '1234567890abcdef1234.png'), 'fixture screenshot bytes');
  const server = await fixture();
  const response = await server.send('/screenshots/run-123-abcdef/1234567890abcdef1234.png');
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.text, 'fixture screenshot bytes');
  assert.equal((await server.send('/screenshots/run-123-abcdef/1234567890abcdef0000.png')).status, 404);
  assert.equal((await server.send('/screenshots/run-123-abcdef/status.json')).status, 404);
});

test('manual scan accepts one same-origin POST and refuses an overlapping scan', async () => {
  const server = await fixture();
  const first = await server.send('/api/run', { method: 'POST', headers: { Origin: server.origin } });
  assert.equal(first.status, 202);
  assert.equal(server.starts(), 1);
  const second = await server.send('/api/run', { method: 'POST', headers: { Origin: server.origin } });
  assert.equal(second.status, 409);
  assert.equal(server.starts(), 1);
  assert.equal((await server.send('/api/status', { method: 'PUT' })).status, 405);
  assert.equal((await server.send('/', { method: 'DELETE' })).status, 405);
});

test('CSRF guard refuses foreign browser origins without invoking a scan', async () => {
  const server = await fixture();
  const response = await server.send('/api/run', { method: 'POST', headers: { Origin: 'https://other.example' } });
  assert.equal(response.status, 403);
  assert.equal(server.starts(), 0);
});

test('CSRF guard handles opaque and malformed browser origins as denied requests', async () => {
  const server = await fixture();
  for (const Origin of ['null', 'not a URL']) {
    assert.equal((await server.send('/api/run', { method: 'POST', headers: { Origin } })).status, 403);
  }
  assert.equal(server.starts(), 0);
});

test('configured authentication protects API, dashboard, screenshots and scan actions', async () => {
  const server = await fixture({ credentials: true });
  const correct = `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`;
  const wrong = `Basic ${Buffer.from('fixture-user:wrong').toString('base64')}`;
  for (const pathname of ['/', '/api/status', '/api/health', '/screenshots/run-123-abcdef/1234567890abcdef1234.png']) {
    const response = await server.send(pathname);
    assert.equal(response.status, 401, pathname);
    assert.match(response.headers['www-authenticate'], /Basic/);
    assert.equal((await server.send(pathname, { headers: { Authorization: wrong } })).status, 401);
  }
  assert.equal((await server.send('/api/run', { method: 'POST', headers: { Origin: server.origin } })).status, 401);
  assert.equal(server.starts(), 0);
  assert.equal((await server.send('/api/status', { headers: { Authorization: correct } })).status, 200);
  assert.equal((await server.send('/api/run', { method: 'POST', headers: { Authorization: correct, Origin: server.origin } })).status, 202);
});

test('configuration rejects zero navigation/render timeouts and zero artifact retention', async () => {
  const current = JSON.parse(await readFile(path.join(monitor.ROOT, 'config.json'), 'utf8'));
  const filename = path.join(directory, 'config.json');
  const inheritedRetention = process.env.RETAINED_RUNS;
  process.env.CONFIG_PATH = filename;
  try {
    delete process.env.RETAINED_RUNS;
    for (const field of ['navigationTimeoutMs', 'renderTimeoutMs', 'retainedRuns']) {
      await writeFile(filename, JSON.stringify({ ...current, [field]: 0 }));
      await assert.rejects(() => monitor.loadConfig(), undefined, field);
    }
  } finally {
    if (inheritedRetention === undefined) delete process.env.RETAINED_RUNS;
    else process.env.RETAINED_RUNS = inheritedRetention;
    if (original.CONFIG_PATH === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = original.CONFIG_PATH;
  }
});
