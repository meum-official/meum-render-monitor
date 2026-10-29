import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORT_FILES, publishReport, restoreReport } from '../publish-report.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const dataRoot = path.resolve(root, 'data');
const report = { schemaVersion: 1, status: 'failed', discovery: { complete: false }, results: [{ id: 'fixture-only', status: 'fail' }] };
const ci = { schemaVersion: 1, fingerprints: { 'https://fixture.invalid': 'fixture-hash' }, errors: [] };

async function native(command, args, options) {
  try { return { ...await exec(command, args, { cwd: options.cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }), exitCode: 0 }; }
  catch (error) { if (Number.isInteger(error.code)) return { stdout: error.stdout || '', stderr: error.stderr || '', exitCode: error.code }; throw error; }
}

async function git(cwd, ...args) {
  const result = await native('git', args, { cwd });
  assert.equal(result.exitCode, 0, `local fixture git ${args[0]} failed`);
  return result.stdout.trim();
}

async function fixture(t, { published = false } = {}) {
  await mkdir(dataRoot, { recursive: true });
  const directory = await mkdtemp(path.join(dataRoot, 'publication-test-'));
  t.after(async () => {
    const relative = path.relative(dataRoot, path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  });
  const bare = path.join(directory, 'remote.git'), seed = path.join(directory, 'checkout'), site = path.join(seed, 'site');
  await mkdir(seed);
  await git(directory, 'init', '--bare', '--initial-branch=main', bare);
  await git(seed, 'init', '-b', 'main');
  await git(seed, 'config', 'user.name', 'Local Fixture Bot');
  await git(seed, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(seed, '.gitignore'), 'data/\nsite/\n');
  await writeFile(path.join(seed, 'README.md'), 'published source\n');
  const tracked = ['README.md', '.gitignore'];
  if (published) {
    await mkdir(path.join(seed, 'docs'));
    await writeFile(path.join(seed, 'docs', 'status.json'), JSON.stringify(report));
    await writeFile(path.join(seed, 'docs', '.monitor-ci.json'), JSON.stringify(ci));
    tracked.push('docs/status.json', 'docs/.monitor-ci.json');
  }
  await git(seed, 'add', '--', ...tracked);
  await git(seed, 'commit', '-m', 'Initial local fixture');
  await git(seed, 'remote', 'add', 'origin', bare);
  await git(seed, 'push', '-u', 'origin', 'main');
  const initial = await git(seed, 'rev-parse', 'HEAD');
  await mkdir(site);
  const contents = { 'index.html': '<!doctype html><title>Fixture report</title>', 'app.js': '/* fixture */', 'style.css': 'body{}', 'status.json': JSON.stringify(report), '.nojekyll': '', '.monitor-ci.json': JSON.stringify(ci) };
  for (const [file, value] of Object.entries(contents)) await writeFile(path.join(site, file), value);
  await writeFile(path.join(site, 'private-debug.txt'), 'must never be committed');
  await mkdir(path.join(site, 'screenshots'));
  await writeFile(path.join(site, 'screenshots', 'private.png'), 'not an image; must never be committed');
  await writeFile(path.join(seed, 'README.md'), 'unpublished local changes\n');
  await writeFile(path.join(seed, 'unpublished.mjs'), 'must stay local\n');
  return { directory, bare, seed, site, initial };
}

function driver(f, { permissionDenied = false, transportError = false, nonFastForward = false, build = 'built', wrongCommit = false, wrongSource = false, pendingFirst = false, lateBuild = false } = {}) {
  const calls = []; let clock = 0, polls = 0, collided = false;
  const runCommand = async (command, args, options) => {
    calls.push({ command, args: [...args] });
    if (command === 'git') {
      if (args[0] === 'push' && nonFastForward && !collided) {
        collided = true;
        const peer = path.join(f.directory, 'peer');
        await git(f.directory, 'clone', f.bare, peer);
        await git(peer, 'config', 'user.name', 'Local Fixture Bot');
        await git(peer, 'config', 'user.email', 'fixture@example.invalid');
        await writeFile(path.join(peer, 'collision.txt'), 'concurrent source change\n');
        await git(peer, 'add', '--', 'collision.txt'); await git(peer, 'commit', '-m', 'Concurrent local fixture update'); await git(peer, 'push', 'origin', 'main');
      }
      return native(command, args, options);
    }
    assert.equal(command, 'gh', 'Only local git and the mocked Pages API are permitted');
    const method = args[2], endpoint = args[3];
    assert.match(endpoint, /^repos\/fixture-owner\/fixture-monitor\/pages(?:\/builds(?:\/latest)?)?$/);
    if (permissionDenied) return { exitCode: 1, stdout: '', stderr: 'HTTP 403 permission denied; fake-token-must-not-escape' };
    if (transportError) return { exitCode: 1, stdout: '', stderr: 'error connecting to api.github.com; no definitive HTTP response' };
    let body;
    if (method === 'GET' && endpoint.endsWith('/pages')) body = { build_type: 'legacy', source: { branch: 'main', path: wrongSource ? '/' : '/docs' }, html_url: 'https://fixture-owner.github.io/fixture-monitor/' };
    else if (method === 'POST' && endpoint.endsWith('/builds')) body = { status: 'queued' };
    else if (method === 'GET' && endpoint.endsWith('/builds/latest')) {
      polls++;
      if (lateBuild) clock += 40;
      const commit = wrongCommit ? f.initial : await git(f.seed, '--git-dir', f.bare, 'rev-parse', 'refs/heads/main');
      body = { commit, status: pendingFirst && polls === 1 ? 'building' : build };
    } else assert.fail('Unexpected mocked Pages operation');
    return { exitCode: 0, stdout: JSON.stringify(body), stderr: '' };
  };
  return { calls, runCommand, now: () => clock, sleep: async ms => { clock += ms; }, pollIntervalMs: 10, pollTimeoutMs: 30 };
}

const options = (f, d) => ({ repoDir: f.seed, siteDir: f.site, repository: 'fixture-owner/fixture-monitor', ...d });

test('core report is pushed and verified despite an explicitly requested optional quota failure', async t => {
  const f = await fixture(t), d = driver(f, { pendingFirst: true }); let optionalCalls = 0;
  const result = await publishReport({ ...options(f, d), optionalUpload: async () => { optionalCalls++; throw new Error('optional storage quota exceeded'); } });
  assert.equal(result.verified, true); assert.equal(result.pushed, true); assert.equal(optionalCalls, 1);
  assert.deepEqual(result.optionalEvidence, { requested: true, uploaded: false }); assert.equal(result.warnings.length, 1);
  assert.deepEqual((await git(f.seed, '--git-dir', f.bare, 'diff', '--name-only', f.initial, 'main')).split('\n').sort(), REPORT_FILES.map(file => `docs/${file}`).sort());
  assert.equal(await git(f.seed, '--git-dir', f.bare, 'show', 'main:README.md'), 'published source');
  const tree = await git(f.seed, '--git-dir', f.bare, 'ls-tree', '-r', '--name-only', 'main');
  assert.doesNotMatch(tree, /private|screenshots|unpublished\.mjs/);
  assert.equal(await readFile(path.join(f.seed, 'README.md'), 'utf8'), 'unpublished local changes\n');
  assert.ok(d.calls.some(call => call.command === 'gh' && call.args[2] === 'POST'));
  assert.ok(!d.calls.some(call => call.args.includes('--force')) || d.calls.filter(call => call.args.includes('--force')).every(call => call.args[0] === 'worktree'));
  assert.equal((await git(f.seed, 'worktree', 'list', '--porcelain')).match(/^worktree /gm).length, 1);
});

test('unchanged six files request a matching build without an empty commit or another push', async t => {
  const f = await fixture(t);
  await publishReport(options(f, driver(f)));
  const d = driver(f), result = await publishReport(options(f, d));
  assert.equal(result.verified, true); assert.equal(result.committed, false); assert.equal(result.pushed, false);
  assert.equal(result.optionalEvidence.requested, false);
  assert.ok(!d.calls.some(call => call.command === 'git' && call.args[0] === 'push'));
});

test('a Pages permission failure cannot leak API stderr or report publication success', async t => {
  const f = await fixture(t), d = driver(f, { permissionDenied: true });
  await assert.rejects(publishReport(options(f, d)), error => {
    assert.match(error.message, /gh api GET failed/); assert.doesNotMatch(error.message, /fake-token/);
    assert.equal(error.details.reason, 'access-denied'); assert.equal(error.details.httpStatus, 403);
    assert.equal(error.details.target, 'repos/fixture-owner/fixture-monitor/pages');
    assert.equal(error.details.state, 'not-published'); assert.equal(error.details.verified, false);
    assert.equal(error.details.pushAttempted, false); return true;
  });
  assert.equal(await git(f.seed, '--git-dir', f.bare, 'rev-parse', 'main'), f.initial);
});

test('a real local non-fast-forward race is rejected without overwriting the other commit', async t => {
  const f = await fixture(t), d = driver(f, { nonFastForward: true });
  await assert.rejects(publishReport(options(f, d)), error => {
    assert.match(error.message, /git push failed/); assert.equal(error.details.reason, 'non-fast-forward');
    assert.equal(error.details.state, 'push-rejected'); assert.equal(error.details.target, 'origin/main');
    assert.equal(error.details.pushAttempted, true); assert.equal(error.details.pushed, false); return true;
  });
  assert.equal(await git(f.seed, '--git-dir', f.bare, 'show', 'main:collision.txt'), 'concurrent source change');
  assert.ok(!d.calls.some(call => call.command === 'gh' && call.args[2] === 'POST'));
});

for (const scenario of [{ name: 'pending build', build: 'building', reason: 'build-pending' }, { name: 'built response for a stale commit', wrongCommit: true, reason: 'build-commit-not-observed' }, { name: 'built response arriving after the deadline', lateBuild: true, reason: 'build-verification-timeout' }]) {
  test(`${scenario.name} never becomes verified merely because push succeeded`, async t => {
    const f = await fixture(t), d = driver(f, scenario);
    await assert.rejects(publishReport(options(f, d)), error => {
      assert.match(error.message, /not verified/); assert.equal(error.details.reason, scenario.reason);
      assert.equal(error.details.state, 'pushed-not-built'); assert.equal(error.details.pushed, true);
      assert.equal(error.details.buildRequested, true); assert.equal(error.details.verified, false); return true;
    });
    assert.notEqual(await git(f.seed, '--git-dir', f.bare, 'rev-parse', 'main'), f.initial);
  });
}

test('an errored matching build fails promptly', async t => {
  const f = await fixture(t), d = driver(f, { build: 'errored' });
  await assert.rejects(publishReport(options(f, d)), /build failed/);
  assert.equal(d.calls.filter(call => call.command === 'gh' && call.args[3].endsWith('/latest')).length, 1);
});

test('the publisher refuses an incompatible Pages source rather than changing policy', async t => {
  const f = await fixture(t), d = driver(f, { wrongSource: true });
  await assert.rejects(publishReport(options(f, d)), error => {
    assert.match(error.message, /main:\/docs/); assert.equal(error.details.reason, 'unsupported-pages-source');
    assert.equal(error.details.state, 'not-published'); return true;
  });
  assert.ok(d.calls.every(call => call.command !== 'gh' || call.args[2] === 'GET'));
  assert.equal(await git(f.seed, '--git-dir', f.bare, 'rev-parse', 'main'), f.initial);
});

test('a connection failure is recorded as uncertain rather than falsely called permission denied', async t => {
  const f = await fixture(t), d = driver(f, { transportError: true });
  await assert.rejects(publishReport(options(f, d)), error => {
    assert.equal(error.details.reason, 'command-outcome-unknown'); assert.equal(error.details.httpStatus, null);
    assert.equal(error.details.state, 'not-published'); assert.equal(error.details.verified, false); return true;
  });
});

test('restore obtains both sanitized states from origin main and preserves failed verdicts', async t => {
  const f = await fixture(t, { published: true });
  const restored = await restoreReport({ repoDir: f.seed, runCommand: native });
  assert.equal(restored.stateRestore, 'restored');
  assert.deepEqual(JSON.parse(await readFile(path.join(f.seed, 'data/status.json'), 'utf8')), report);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.seed, 'data/ci-state.json'), 'utf8')), ci);
});

test('first run requires both remote state files absent and refuses unpublished local state', async t => {
  const f = await fixture(t);
  assert.equal((await restoreReport({ repoDir: f.seed, runCommand: native })).stateRestore, 'none');
  await writeFile(path.join(f.seed, 'data/ci-state.json'), JSON.stringify(ci));
  await assert.rejects(restoreReport({ repoDir: f.seed, runCommand: native }), /Unpublished local state/);
});

test('partial or corrupt published state is never treated as a first run', async t => {
  const f = await fixture(t, { published: true });
  await git(f.seed, 'rm', '--', 'docs/.monitor-ci.json');
  await git(f.seed, 'commit', '-m', 'Local partial-state fixture'); await git(f.seed, 'push', 'origin', 'main');
  await assert.rejects(restoreReport({ repoDir: f.seed, runCommand: native }), /partial restore/);
  await writeFile(path.join(f.seed, 'docs/.monitor-ci.json'), '{bad-json');
  await git(f.seed, 'add', '--', 'docs/.monitor-ci.json'); await git(f.seed, 'commit', '-m', 'Local corrupt-state fixture'); await git(f.seed, 'push', 'origin', 'main');
  await assert.rejects(restoreReport({ repoDir: f.seed, runCommand: native }), /JSON is invalid/);
});

test('missing or non-file allowlisted input fails before any remote API or push', async t => {
  const f = await fixture(t), d = driver(f);
  await rm(path.join(f.site, 'app.js')); await mkdir(path.join(f.site, 'app.js'));
  await assert.rejects(publishReport(options(f, d)), /regular file/);
  assert.equal(d.calls.length, 0);
});

test('workflow preserves failure signals and contains no quota-dependent transfer or delete steps', async () => {
  const workflow = await readFile(new URL('../.github/workflows/render-check.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /actions\/(?:cache|upload-artifact|download-artifact|upload-pages-artifact|deploy-pages)|actions\/(?:caches|artifacts)|--method\s+DELETE/);
  assert.match(workflow, /contents: write/); assert.match(workflow, /pages: write/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /run: node publish-report\.mjs restore/);
  assert.match(workflow, /if: always\(\) && steps\.export\.outcome == 'success'/);
  assert.match(workflow, /PUBLICATION_VERIFIED.*\n/);
  assert.match(workflow, /\[ "\$PUBLICATION_VERIFIED" != 'true' \]/);
  assert.match(workflow, /\[ "\$SCAN_EXIT_CODE" != '0' \]/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
});
