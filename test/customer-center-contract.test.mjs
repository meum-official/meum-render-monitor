import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { ruleFor } from '../contracts.mjs';
import { launchBrowser, probe } from '../probe.mjs';

const routes = ['/customer-center/notice', '/customer-center/event', '/customer-center/qna'];
const oldColumnHeader = '.customer-center__view .board .first-board';

test('customer center contracts require real board content rather than the responsive column header', () => {
  for (const route of routes) {
    const rule = ruleFor('https://meum.me' + route);
    assert.ok(rule.selectors.includes('.customer-center__view .board .table-board .board-item'));
    assert.ok(!rule.selectors.includes(oldColumnHeader));
  }
});

test('local customer center desktop/mobile fixtures reject a header-only board and accept visible content', { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 45000 }, async () => {
  const server = createServer((req, res) => {
    const populated = !new URL(req.url, 'http://localhost').searchParams.has('empty');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    // CustomerCenterBoard.vue and _customer-center-board.scss hide only the column header below 600px.
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      body{margin:0;background:linear-gradient(125deg,#e1edff,#d5f1e5);font:18px system-ui;color:#17243b;min-height:100vh}
      .customer-center{margin:30px;padding:24px;background:white}.board{display:grid;gap:8px;padding:0;list-style:none}
      .first-board,.board-item{display:flex;padding:18px 24px}.board-item{min-height:64px;width:100%;border:0;text-align:left;background:#eef2f6}
      @media(max-width:600px){.board .first-board{display:none}}
      </style></head><body><main class="customer-center"><h1 class="hero__title">Synthetic customer center</h1>
      <div class="customer-center__view"><ul class="board"><li class="first-board"><p>Number</p><p>Title</p><p>Date</p></li>
      ${populated ? '<li class="table-board"><button class="board-item">Synthetic board content demonstrates that the page body is actually present.</button></li>' : ''}
      </ul></div></main></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await launchBrowser();
    for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844, isMobile: true }]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: !!viewport.isMobile });
      const page = await context.newPage();
      await page.goto(origin + routes[0]);
      assert.equal(await page.locator(oldColumnHeader).isVisible(), viewport.name === 'desktop', 'the old condition fails on a healthy mobile page');
      await context.close();
      for (const [index, route] of routes.entries()) {
        const check = empty => probe(browser, {
          id: String(index + 1).repeat(20), url: origin + route + (empty ? '?empty=1' : ''),
          viewport, rule: ruleFor('https://meum.me' + route),
        }, { origins: [origin], navigationTimeoutMs: 3000, renderTimeoutMs: 250, settleMs: 50, captureScreenshots: false }, 'unused');
        const populated = await check(false);
        assert.equal(populated.status, 'pass', `${route} ${viewport.name}: visible board content`);
        assert.equal(populated.diagnostics.readiness.state, 'ready');
        const headerOnly = await check(true);
        assert.equal(headerOnly.status, 'fail', `${route} ${viewport.name}: a header alone cannot prove content loaded`);
        assert.ok(headerOnly.issues.some(issue => issue.kind === 'required-content'));
      }
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
