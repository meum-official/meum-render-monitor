import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('.', import.meta.url));
export const REPORT_FILES = Object.freeze(['index.html', 'app.js', 'style.css', 'status.json', '.nojekyll', '.monitor-ci.json']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function nativeCommand(command, args, options) {
  try {
    const result = await execFileAsync(command, args, { cwd: options.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return { ...result, exitCode: 0 };
  } catch (error) {
    if (Number.isInteger(error.code)) return { stdout: error.stdout || '', stderr: error.stderr || '', exitCode: error.code };
    throw failure(`${command} ${error.killed ? 'timed out' : 'could not start'}`, { reason: error.killed ? 'command-timeout' : 'command-start-failed' });
  }
}

const failure = (message, details) => Object.assign(new Error(message), { details });

function commands(runCommand, repoDir) {
  return async (command, args, { cwd = repoDir, allowed = [0], timeoutMs = 60_000 } = {}) => {
    const action = command === 'gh' ? `gh api ${args[2]}` : `git ${args[0] === '-c' ? 'commit' : args[0]}`;
    const target = command === 'gh' ? args[3] : ['fetch', 'push'].includes(args[0]) ? 'origin/main' : 'local-publication-state';
    let result;
    try { result = await runCommand(command, args, { cwd, timeoutMs }); }
    catch (error) { throw failure(`${action} could not complete`, { action, target, reason: error.details?.reason || 'command-outcome-unknown' }); }
    if (!result || !Number.isInteger(result.exitCode) || !allowed.includes(result.exitCode)) {
      const stderr = String(result?.stderr || '');
      const httpStatus = Number(stderr.match(/HTTP\s+([45]\d{2})/i)?.[1]) || null;
      const reason = /non-fast-forward|Updates were rejected|\[rejected\].*fetch first/i.test(stderr) ? 'non-fast-forward' : httpStatus === 401 || httpStatus === 403 || /permission denied|Resource not accessible/i.test(stderr) ? 'access-denied' : 'command-outcome-unknown';
      throw failure(`${action} failed (${reason}; exit ${Number.isInteger(result?.exitCode) ? result.exitCode : 'unknown'})`, { action, target, reason, httpStatus, exitCode: result?.exitCode ?? null });
    }
    return result;
  };
}

function validateState(report, state) {
  if (report?.schemaVersion !== 1 || !Array.isArray(report.results)) throw new Error('Published report state is invalid; refusing to reset it');
  if (state?.schemaVersion !== 1 || !state.fingerprints || typeof state.fingerprints !== 'object' || Array.isArray(state.fingerprints)) throw new Error('Published CI state is invalid; refusing to reset it');
}

function checkedDataPath(repoDir, target) {
  const data = path.resolve(repoDir, 'data');
  const resolved = path.resolve(target);
  const relative = path.relative(data, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Publication temporary paths must stay inside this repository data directory');
  return resolved;
}

export async function restoreReport({ repoDir = root, dataDir = path.join(repoDir, 'data'), runCommand = nativeCommand } = {}) {
  repoDir = path.resolve(repoDir); dataDir = checkedDataPath(repoDir, dataDir);
  const execute = commands(runCommand, repoDir);
  await execute('git', ['fetch', '--no-tags', 'origin', 'main']);
  const sourceCommit = (await execute('git', ['rev-parse', 'FETCH_HEAD'])).stdout.trim();
  const present = (await execute('git', ['ls-tree', '-r', '--name-only', 'FETCH_HEAD', '--', 'docs/status.json', 'docs/.monitor-ci.json'])).stdout.split(/\r?\n/).filter(Boolean);
  const published = [];
  for (const file of ['status.json', '.monitor-ci.json']) {
    published.push(present.includes(`docs/${file}`) ? (await execute('git', ['show', `FETCH_HEAD:docs/${file}`])).stdout : null);
  }
  if (published.some(value => value === null) && published.some(value => value !== null)) throw new Error('Published report and CI state must both exist; refusing a partial restore');
  await mkdir(dataDir, { recursive: true });
  if (published.every(value => value === null)) {
    for (const file of ['status.json', 'ci-state.json']) {
      try { await lstat(path.join(dataDir, file)); throw new Error('Unpublished local state exists; refusing to use it as a first run'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { stateRestore: 'none', stateReady: true, sourceCommit };
  }
  let report, state;
  try { report = JSON.parse(published[0]); state = JSON.parse(published[1]); }
  catch { throw new Error('Published state JSON is invalid; refusing to reset it'); }
  validateState(report, state);
  await writeFile(path.join(dataDir, 'status.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(dataDir, 'ci-state.json'), JSON.stringify(state, null, 2) + '\n');
  return { stateRestore: 'restored', stateReady: true, sourceCommit };
}

export async function publishReport(options = {}) {
  const progress = { phase: 'input-validation', state: 'not-published', commit: null, pushAttempted: false, pushed: false, buildRequestAttempted: false, buildRequested: false, lastBuildStatus: null, lastBuildCommit: null };
  try { return await performPublish(options, progress); }
  catch (error) {
    const state = progress.phase === 'push-docs' && ['non-fast-forward', 'access-denied'].includes(error.details?.reason) ? 'push-rejected' : progress.state;
    throw failure(error.message, { ...progress, state, reason: 'validation-failed', ...error.details, verified: false });
  }
}

async function performPublish({ repoDir = root, siteDir = path.join(repoDir, 'site'), repository = process.env.GITHUB_REPOSITORY, runCommand = nativeCommand, optionalUpload, now = Date.now, sleep = pause, pollIntervalMs = 10_000, pollTimeoutMs = 300_000 }, progress) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('GITHUB_REPOSITORY must identify owner/repository');
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0 || !Number.isFinite(pollTimeoutMs) || pollTimeoutMs <= 0 || pollTimeoutMs > 300_000) throw new Error('Pages verification must use a positive polling interval and at most five minutes');
  if (optionalUpload !== undefined && typeof optionalUpload !== 'function') throw new Error('Optional evidence upload must be an explicitly supplied function');
  repoDir = path.resolve(repoDir); siteDir = path.resolve(siteDir);
  const execute = commands(runCommand, repoDir);
  const files = new Map();
  for (const file of REPORT_FILES) {
    const target = path.join(siteDir, file);
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Report file must be a regular file: ${file}`);
    files.set(file, await readFile(target));
  }
  if ([...files.values()].reduce((sum, buffer) => sum + buffer.length, 0) > 100 * 1024 * 1024) throw new Error('Allowlisted report exceeds the publication size limit');
  let report, state;
  try { report = JSON.parse(files.get('status.json')); state = JSON.parse(files.get('.monitor-ci.json')); }
  catch { throw new Error('Report publication JSON is invalid'); }
  validateState(report, state);
  const api = async (method, suffix, timeoutMs = 30_000) => {
    const result = await execute('gh', ['api', '--method', method, `repos/${repository}/pages${suffix}`], { timeoutMs });
    try { return JSON.parse(result.stdout); } catch { throw failure('Pages API returned invalid JSON', { action: `gh api ${method}`, target: `repos/${repository}/pages${suffix}`, reason: 'api-response-invalid' }); }
  };
  progress.phase = 'pages-source-check';
  const pages = await api('GET', '');
  if (pages.build_type !== 'legacy' || pages.source?.branch !== 'main' || pages.source?.path !== '/docs') throw failure('Pages must already publish from main:/docs; this program does not change settings or access policies', { action: 'validate-pages-source', target: `repos/${repository}/pages`, reason: 'unsupported-pages-source' });
  const pageUrl = new URL(pages.html_url);
  if (pageUrl.protocol !== 'https:' || pageUrl.username || pageUrl.password || pageUrl.search || pageUrl.hash) throw new Error('Pages returned an invalid public site URL');
  progress.phase = 'fetch-main';
  await execute('git', ['fetch', '--no-tags', 'origin', 'main']);
  const dataDir = checkedDataPath(repoDir, path.join(repoDir, 'data'));
  await mkdir(dataDir, { recursive: true });
  const worktree = checkedDataPath(repoDir, await mkdtemp(path.join(dataDir, 'publication-')));
  const warnings = [];
  try {
    progress.phase = 'prepare-docs-commit';
    await execute('git', ['worktree', 'add', '--detach', worktree, 'FETCH_HEAD']);
    const docs = path.join(worktree, 'docs');
    try { const metadata = await lstat(docs); if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Publication docs path is not a real directory'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(docs, { recursive: true });
    for (const [file, contents] of files) {
      const destination = path.join(docs, file);
      try { const metadata = await lstat(destination); if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Existing docs file is not a regular file: ${file}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await writeFile(destination, contents);
    }
    const allowedPaths = REPORT_FILES.map(file => `docs/${file}`);
    await execute('git', ['add', '--', ...allowedPaths], { cwd: worktree });
    const staged = (await execute('git', ['diff', '--cached', '--name-only', '-z'], { cwd: worktree })).stdout.split('\0').filter(Boolean);
    if (staged.some(file => !allowedPaths.includes(file))) throw new Error('Publication staging contains an unregistered path');
    const committed = staged.length > 0;
    if (committed) await execute('git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', 'Publish external monitor report'], { cwd: worktree });
    const commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Publication commit is invalid');
    progress.commit = commit;
    if (committed) {
      progress.phase = 'push-docs'; progress.pushAttempted = true; progress.state = 'push-outcome-unknown';
      await execute('git', ['push', 'origin', 'HEAD:main'], { cwd: worktree });
      progress.pushed = true;
    }
    progress.state = 'pushed-not-built'; progress.phase = 'request-build'; progress.buildRequestAttempted = true;
    await api('POST', '/builds');
    progress.buildRequested = true; progress.phase = 'verify-build';
    const deadline = now() + pollTimeoutMs;
    while (true) {
      if (now() >= deadline) throw failure('Pages publication was not verified for the published report commit within the deadline', { action: 'verify-pages-build', target: `repos/${repository}/pages/builds/latest`, reason: progress.lastBuildCommit === commit ? 'build-pending' : 'build-commit-not-observed' });
      const build = await api('GET', '/builds/latest', Math.min(30_000, deadline - now()));
      progress.lastBuildStatus = ['built', 'building', 'queued', 'errored', 'error', 'failed'].includes(build.status) ? build.status : 'unknown';
      progress.lastBuildCommit = /^[a-f0-9]{40,64}$/.test(build.commit || '') ? build.commit : null;
      if (now() > deadline) throw failure('Pages publication was not verified within the deadline', { action: 'verify-pages-build', target: `repos/${repository}/pages/builds/latest`, reason: 'build-verification-timeout' });
      if (build.commit === commit && build.status === 'built') break;
      if (build.commit === commit && ['errored', 'error', 'failed'].includes(build.status)) throw failure('Pages build failed for the published report commit', { action: 'verify-pages-build', target: `repos/${repository}/pages/builds/latest`, reason: 'build-failed' });
      await sleep(Math.min(pollIntervalMs, deadline - now()));
    }
    const result = { verified: true, commit, committed, pushed: committed, pageUrl: pageUrl.href, files: allowedPaths, warnings, optionalEvidence: { requested: typeof optionalUpload === 'function', uploaded: false } };
    if (optionalUpload) {
      try { await optionalUpload({ commit, siteDir }); result.optionalEvidence.uploaded = true; }
      catch { warnings.push('Optional evidence upload failed; the core report publication remains verified'); }
    }
    return result;
  } finally {
    try { await execute('git', ['worktree', 'remove', '--force', worktree]); }
    catch { warnings.push('Temporary publication worktree cleanup failed'); }
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  if (process.argv[2] === 'restore') {
    const restored = await restoreReport();
    if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `MONITOR_JOB_STARTED_AT=${startedAt}\nMONITOR_STATE_RESTORE=${restored.stateRestore}\nMONITOR_STATE_READY=true\n`);
    console.log(JSON.stringify(restored));
    return;
  }
  if (process.argv[2]) throw new Error('Usage: node publish-report.mjs [restore]');
  const published = await publishReport();
  const dataDir = path.join(root, 'data'); await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'publication.json'), JSON.stringify(published, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `verified=true\ncommit=${published.commit}\npage_url=${published.pageUrl}\n`);
  console.log(JSON.stringify(published));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(async error => {
  const evidence = { observedAt: new Date().toISOString(), operation: process.argv[2] === 'restore' ? 'restore' : 'publish', verified: false, ...error.details };
  try { await mkdir(path.join(root, 'data'), { recursive: true }); await writeFile(path.join(root, 'data', 'publication-error.json'), JSON.stringify(evidence, null, 2) + '\n'); } catch { /* Failure remains visible even if local evidence cannot be saved. */ }
  console.error(error.message); process.exitCode = 2;
});
