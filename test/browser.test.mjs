import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, probe } from '../probe.mjs';

const enabled = process.env.RUN_BROWSER_TESTS === '1';
const rule = { selectors: ['main h1'], loading: [], errors: [] };
const paragraph = '<p>This local fixture contains enough visible text to represent a completed exhibition page.</p>';
const healthy = `<main><h1>Exhibition rendering fixture</h1>${paragraph}</main>`;
const documentFor = body => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local monitor fixture</title><style>body{margin:0;min-height:100vh;background:linear-gradient(125deg,#e1edff,#d5f1e5);font:20px system-ui;color:#17243b}main{margin:60px;padding:40px;min-height:340px;background:#fff;border-radius:18px}h1{font-size:36px}.spinner{padding:20px;background:#f4d49b}.hero-background{height:240px;background-size:cover;background-image:url('/missing-hero.png')}</style></head><body>${body}</body></html>`;

describe('real Chromium render checks using only local HTTP fixtures', { skip: !enabled, concurrency: false }, () => {
  let browser;
  let server;
  let origin;
  let directory;
  let sequence = 0;
  let config;

  before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'meum-render-monitor-browser-'));
    server = createServer((request, response) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/redirect') {
        response.writeHead(302, { Location: '/healthy' });
        response.end();
        return;
      }
      if (pathname === '/missing-hero.png' || pathname === '/missing-image.png') {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('Fixture image missing');
        return;
      }
      const fixtures = {
        '/healthy': healthy,
        '/crash': `${healthy}<script>setTimeout(() => { throw new Error('fixture app initialized twice'); }, 10);</script>`,
        '/blank': '<style>body{background:#fff}</style>',
        '/missing-content': `<main><h2>Required exhibition heading failed to mount</h2>${paragraph}</main>`,
        '/loading': `${healthy}<div class="spinner">Exhibition is still loading</div>`,
        '/error-screen': `${healthy}<section class="fixture-error" role="alert">Exhibition data could not be loaded</section>`,
        '/not-found': healthy,
        '/missing-background': `${healthy}<div class="hero-background" aria-label="Exhibition cover"></div>`,
        '/missing-image': `${healthy}<img width="400" height="180" src="/missing-image.png" alt="Exhibition artwork">`,
        '/password': `${healthy}<section class="exhibition-password-dialog" role="dialog">Enter the exhibition password to continue.</section>`,
        '/unknown': healthy,
      };
      response.writeHead(pathname === '/not-found' ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(documentFor(fixtures[pathname] || healthy));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    config = { origins: [origin], navigationTimeoutMs: 3000, renderTimeoutMs: 250, settleMs: 100 };
    browser = await launchBrowser();
  });

  after(async () => {
    await browser?.close();
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (directory) {
      const resolved = path.resolve(directory);
      assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
      assert.ok(path.basename(resolved).startsWith('meum-render-monitor-browser-'));
      await rm(resolved, { recursive: true, force: true });
    }
  });

  const check = async (pathname, override = rule) => {
    const target = {
      id: (++sequence).toString(16).padStart(20, '0'),
      url: `${origin}${pathname}`,
      name: pathname,
      viewport: { name: 'desktop', width: 1280, height: 800 },
      ...(override ? { rule: override } : {}),
    };
    return probe(browser, target, config, directory);
  };
  const hasIssue = (result, kind) => result.issues.some(issue => issue.kind === kind);

  it('passes a rendered page and saves screenshot evidence', async () => {
    const result = await check('/healthy');
    assert.equal(result.status, 'pass', JSON.stringify(result.issues));
    assert.equal(result.httpStatus, 200);
    assert.equal(result.issues.length, 0);
    assert.ok(result.screenshot?.endsWith(`${result.id}.png`));
    assert.ok((await stat(path.join(directory, `${result.id}.png`))).size > 1000);
  });

  it('fails an uncaught JavaScript exception even when the page still has content', async () => {
    const result = await check('/crash');
    assert.equal(result.status, 'fail');
    assert.ok(hasIssue(result, 'javascript'));
    assert.ok(result.issues.some(issue => issue.message.includes('fixture app initialized twice')));
  });

  it('fails a blank HTTP 200 page', async () => {
    const result = await check('/blank');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.status, 'fail');
    assert.ok(hasIssue(result, 'blank-screen') || hasIssue(result, 'empty-dom'));
  });

  it('fails a page missing its required content despite a valid shared shell', async () => {
    const result = await check('/missing-content');
    assert.equal(result.status, 'fail');
    assert.ok(hasIssue(result, 'required-content'));
  });

  it('fails when a loading indicator never clears', async () => {
    const result = await check('/loading', { ...rule, loading: ['.spinner'] });
    assert.equal(result.status, 'fail');
    assert.ok(hasIssue(result, 'loading'));
  });

  it('fails a visible application error screen', async () => {
    const result = await check('/error-screen', { ...rule, errors: ['.fixture-error'] });
    assert.equal(result.status, 'fail');
    assert.ok(hasIssue(result, 'error-screen'));
  });

  it('fails an unexpected same-origin redirect even when its destination renders', async () => {
    const result = await check('/redirect');
    assert.equal(result.finalUrl, `${origin}/healthy`);
    assert.equal(result.status, 'fail');
    assert.ok(hasIssue(result, 'redirect'));
  });

  it('leaves an unsupported route unknown instead of turning a generic shell green', async () => {
    const result = await check('/unknown', null);
    assert.equal(result.status, 'unknown', JSON.stringify(result.issues));
  });

  it('fails an HTTP 404 even if the returned HTML looks healthy', async () => {
    const result = await check('/not-found');
    assert.equal(result.httpStatus, 404);
    assert.equal(result.status, 'fail');
    assert.ok(hasIssue(result, 'http'));
  });

  it('fails a missing visible CSS background image', async () => {
    const result = await check('/missing-background');
    assert.equal(result.status, 'fail', JSON.stringify(result.issues));
    assert.ok(result.issues.some(issue => /background/.test(issue.kind) || issue.message.includes('missing-hero.png')));
  });

  it('fails a visible broken artwork image', async () => {
    const result = await check('/missing-image');
    assert.equal(result.status, 'fail');
    assert.ok(hasIssue(result, 'broken-image'));
  });

  it('does not mark a password gate as a verified exhibition', async () => {
    const result = await check('/password', { ...rule, unknownSelectors: ['.exhibition-password-dialog'] });
    assert.equal(result.status, 'unknown', JSON.stringify(result.issues));
  });
});
