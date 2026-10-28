import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

export { ruleFor } from './contracts.mjs';
import { ruleFor, allowedNavigation } from './contracts.mjs';

export function pixelStats(buffer) {
  const png = PNG.sync.read(buffer);
  const bins = new Map();
  let count = 0;
  for (let y = 0; y < png.height; y += 6) for (let x = 0; x < png.width; x += 6) {
    const n = (y * png.width + x) * 4;
    const key = ((png.data[n] >> 4) << 8) | ((png.data[n + 1] >> 4) << 4) | (png.data[n + 2] >> 4);
    bins.set(key, (bins.get(key) || 0) + 1); count++;
  }
  return { colors: bins.size, dominantRatio: Math.max(...bins.values()) / count };
}

export function safeMessage(value) {
  return String(value).replace(/(https?:\/\/[^\s?'"<>]+)\?[^\s'"<>]*/g, '$1?[query omitted]').replace(/(bearer\s+)[\w.+/=-]+/gi, '$1[redacted]').slice(0, 900);
}

export async function launchBrowser() {
  const { chromium } = await import('playwright');
  const options = { headless: true, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  try { return await chromium.launch(options); }
  catch (error) {
    // shortcut: use installed Edge on Windows; containers install pinned Chromium.
    if (process.platform === 'win32' && !options.executablePath) return chromium.launch({ ...options, channel: 'msedge' });
    throw error;
  }
}

export async function probe(browser, target, config, screenshotDirectory) {
  const start = Date.now();
  const result = { ...target, status: 'pending', checkedAt: null, durationMs: 0, httpStatus: null, issues: [], checks: [], screenshot: null };
  const issue = (kind, message) => { if (result.issues.length < 30) result.issues.push({ kind, message: safeMessage(message) }); };
  const context = await browser.newContext({ viewport: { width: target.viewport.width, height: target.viewport.height }, deviceScaleFactor: 1, isMobile: !!target.viewport.isMobile, hasTouch: !!target.viewport.isMobile, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const page = await context.newPage();
  let fatalEvent;
  const fatal = new Promise(resolve => { fatalEvent = resolve; });
  const rule = { selectors: [], loading: [], errors: [], unknownSelectors: [], ...(target.rule || ruleFor(target.url)) };
  const serviceHosts = new Set([...config.origins.map(x => new URL(x).hostname), 'backend.meum.me']);
  const critical = (request) => {
    const type = request.resourceType();
    const u = new URL(request.url());
    return serviceHosts.has(u.hostname) && (['document', 'script', 'stylesheet'].includes(type) || (['xhr', 'fetch'].includes(type) && /\/(room|rooms|boards|archive|oneday|creator|gallery|public)(\/|\?|$)/.test(u.pathname)));
  };
  page.on('pageerror', e => { issue('javascript', e.message); fatalEvent(); });
  page.on('crash', () => { issue('browser-crash', '브라우저 탭이 종료됐습니다.'); fatalEvent(); });
  page.on('requestfailed', r => { if (critical(r) && !/ERR_ABORTED/.test(r.failure()?.errorText || '')) issue('network', `${r.failure()?.errorText}: ${r.url()}`); });
  page.on('response', r => { if (r.status() >= 400 && critical(r.request())) issue('http-resource', `HTTP ${r.status()}: ${r.url()}`); });
  try {
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
    result.httpStatus = response?.status() ?? null;
    if (!response || !response.ok()) issue('http', `페이지 응답: ${result.httpStatus ?? '없음'}`);
    result.finalUrl = page.url();
    if (!config.origins.includes(new URL(result.finalUrl).origin) || !allowedNavigation(target.url, result.finalUrl)) issue('redirect', '요청한 페이지와 다른 화면으로 이동했습니다.');
    const timeout = rule.canvas ? Math.max(config.renderTimeoutMs, 90000) : config.renderTimeoutMs;
    try {
      await Promise.race([fatal, page.waitForFunction(({ selectors, loading, errors, unknownSelectors, requiredGlobal }) => {
        const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0; };
        return [...errors, ...unknownSelectors].some(s => [...document.querySelectorAll(s)].some(visible)) || (selectors.every(s => [...document.querySelectorAll(s)].some(visible)) && loading.every(s => ![...document.querySelectorAll(s)].some(visible)) && (!requiredGlobal || !!window[requiredGlobal]) && (document.body?.innerText.trim().length > 30 || document.querySelector('canvas')));
      }, rule, { timeout })]);
    } catch { issue('render-timeout', `화면 준비 조건을 ${timeout / 1000}초 안에 충족하지 못했습니다.`); }
    await page.waitForTimeout(config.settleMs);
    const dom = await page.evaluate(({ selectors, loading, errors, unknownSelectors, requiredGlobal }) => {
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0; };
      const app = document.querySelector('#app') || document.body;
      return {
        textLength: app.innerText.trim().length,
        visibleElements: [...app.querySelectorAll('h1,h2,p,a,button,input,img,canvas')].filter(visible).length,
        missing: selectors.filter(s => ![...document.querySelectorAll(s)].some(visible)),
        loading: loading.filter(s => [...document.querySelectorAll(s)].some(visible)),
        errors: errors.flatMap(s => [...document.querySelectorAll(s)].filter(visible).map(e => e.textContent.trim().slice(0, 200))),
        brokenImages: [...document.images].filter(el => { const r = el.getBoundingClientRect(); return visible(el) && r.top < innerHeight && r.bottom > 0 && el.complete && !el.naturalWidth; }).map(el => el.currentSrc || el.src).slice(0, 5),
        accessGate: unknownSelectors.some(s => [...document.querySelectorAll(s)].some(visible)),
        globalReady: !requiredGlobal || !!window[requiredGlobal],
        backgrounds: [...app.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return visible(el) && r.top < innerHeight && r.bottom > 0; }).flatMap(el => [...getComputedStyle(el).backgroundImage.matchAll(/url\(["']?(.+?)["']?\)/g)].map(m => m[1])).slice(0, 12),
        title: document.title
      };
    }, rule);
    result.title = dom.title;
    if (dom.missing.length && !dom.accessGate) issue('required-content', `필수 화면 요소 없음: ${dom.missing.join(', ')}`);
    if (!dom.globalReady && !dom.accessGate) issue('3d-not-ready', '3D 엔진의 준비 완료를 확인하지 못했습니다.');
    if (dom.loading.length && !dom.accessGate) issue('loading', `로딩이 끝나지 않았습니다: ${dom.loading.join(', ')}`);
    for (const message of dom.errors) issue('error-screen', message);
    if (dom.visibleElements < (rule.canvas ? 1 : 2) || (!rule.canvas && dom.textLength < 30)) issue('empty-dom', `본문이 비어 있습니다 (텍스트 ${dom.textLength}자, 화면 요소 ${dom.visibleElements}개).`);
    for (const url of dom.brokenImages) issue('broken-image', url);
    const brokenBackgrounds = await page.evaluate(async urls => (await Promise.all([...new Set(urls)].map(url => new Promise(resolve => {
      const img = new Image(); const timeout = setTimeout(() => resolve(url), 3000);
      img.onload = () => { clearTimeout(timeout); resolve(null); }; img.onerror = () => { clearTimeout(timeout); resolve(url); }; img.src = url;
    })))).filter(Boolean), dom.backgrounds);
    for (const url of brokenBackgrounds) issue('broken-background', url);
    await mkdir(screenshotDirectory, { recursive: true });
    const filename = `${target.id}.png`;
    const buffer = await page.screenshot({ path: path.join(screenshotDirectory, filename), fullPage: false, timeout: 15000 });
    result.screenshot = `/screenshots/${path.basename(screenshotDirectory)}/${filename}`;
    const pixels = pixelStats(buffer);
    if (pixels.dominantRatio > 0.997) issue('blank-screen', `화면의 ${(pixels.dominantRatio * 100).toFixed(1)}%가 같은 색입니다.`);
    if (rule.canvas && !dom.accessGate) {
      const canvas = page.locator('canvas#unity-canvas').first();
      if (await canvas.isVisible()) {
        const stats = pixelStats(await canvas.screenshot({ timeout: 10000 }));
        if (stats.dominantRatio > 0.995 || stats.colors < 8) issue('blank-canvas', '3D 캔버스에 실제 장면이 표시되지 않습니다.');
      }
    }
    result.checks = [
      { name: 'HTTP 응답', passed: !!response?.ok() },
      { name: '브라우저 실행', passed: !result.issues.some(x => ['javascript', 'browser-crash'].includes(x.kind)) },
      { name: '필수 화면 요소', passed: rule.unsupported || dom.accessGate ? null : !dom.missing.length && !dom.loading.length && !dom.errors.length && dom.globalReady, detail: rule.selectors.length ? `${rule.selectors.length}개 확인` : '페이지별 검사 기준 미등록' },
      { name: '실제 화면 픽셀', passed: !result.issues.some(x => ['blank-screen', 'blank-canvas', 'empty-dom'].includes(x.kind)) }
    ];
    result.status = result.issues.length ? 'fail' : dom.accessGate || rule.unsupported ? 'unknown' : 'pass';
    if (dom.accessGate) issue('access-required', '입장/비밀번호 안내 화면으로 실제 관람 장면은 미확인입니다.');
    if (rule.unsupported) issue('contract', '이 경로의 필수 화면 검사 기준을 등록해야 합니다.');
    if (config.followViewerEntries && target.group === '전시 프리뷰' && result.status === 'pass') {
      const button = page.locator('.hero__actions .button--hero').first();
      if (await button.isEnabled()) {
        let viewerUrl;
        const isViewer = raw => { const u = new URL(raw); return config.origins.includes(u.origin) && (u.pathname === '/meum-lite-viewer' || /\/viewer(?:\/|$)/.test(u.pathname)); };
        // Capture the public entry URL, then render it separately with a fresh guest context.
        await context.route('**/*', async route => {
          if (route.request().isNavigationRequest() && isViewer(route.request().url())) { viewerUrl = route.request().url(); await route.abort(); }
          else await route.continue();
        });
        try {
          await button.click({ timeout: 2500, noWaitAfter: true });
          await page.waitForTimeout(800);
          if (!viewerUrl && isViewer(page.url())) viewerUrl = page.url();
        } catch (error) { issue('entry-discovery', error.message); }
        if (viewerUrl) {
          const clean = new URL(viewerUrl);
          for (const key of [...clean.searchParams.keys()]) if (!['r', 'room_id', 'roomId'].includes(key)) clean.searchParams.delete(key);
          result.discoveredPages = [{ url: clean.href, name: `${target.name} · 3D 관람`, group: '3D 관람', discoveredFrom: target.url }];
        } else { issue('entry-discovery', '관람 버튼의 실제 목적지를 확인하지 못했습니다.'); result.status = 'unknown'; }
      }
    }
    if (result.status === 'pass' && result.issues.length) result.status = 'fail';
  } catch (e) {
    issue('navigation', e.message); result.status = 'fail';
    try {
      await mkdir(screenshotDirectory, { recursive: true });
      await page.screenshot({ path: path.join(screenshotDirectory, `${target.id}.png`), timeout: 5000 });
      result.screenshot = `/screenshots/${path.basename(screenshotDirectory)}/${target.id}.png`;
    } catch { /* Failed navigation may leave no paintable page. */ }
  } finally {
    result.checkedAt = new Date().toISOString(); result.durationMs = Date.now() - start;
    await context.close().catch(() => {});
  }
  return result;
}
