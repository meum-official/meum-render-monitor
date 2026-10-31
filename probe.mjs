import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { readPolicyDecision } from './read-only-policy.mjs';
import { createDiagnostics, safeLocation } from './diagnostic.mjs';

export { ruleFor } from './contracts.mjs';
import { ruleFor, allowedNavigation } from './contracts.mjs';
import { renderingConfig, renderRuleFor, renderReadAllowed, observeLayout, observeLazyImages } from './render-mode.mjs';

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
  return String(value).replace(/(https?:\/\/[^\s?'"<>]+)\?[^\s'"<>]*/g, '$1?[query omitted]').replace(/(bearer\s+)[\w.+/=-]+/gi, '$1[redacted]').replace(/((?:password|passwd|access_token|refresh_token|authorization|client_secret|api[_-]?key|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]').slice(0, 900);
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

export async function installReadOnlyGuard(context, origins, trace, policy = null) {
  const blocked = [];
  const requests = new WeakSet();
  const hosts = new Set([...origins.map(value => new URL(value).hostname), 'backend.meum.me']);
  const counts = { blockedServiceWrites: 0, blockedServiceSockets: 0, blockedExternalWrites: 0, blockedExternalSockets: 0, blockedMutatingReads: 0 };
  const effectsAllowed = new Set();
  await context.route('**/*', async route => {
    const request = route.request();
    const read = ['GET', 'HEAD'].includes(request.method());
    const decision = readPolicyDecision(request.url());
    let observation;
    if (policy) {
      try { observation = policy.request(request); } catch { observation = { allowed: false }; }
      if (observation?.allowed === true) {
        effectsAllowed.add(observation.effect);
        return route.continue();
      }
    } else if (read && !decision.blocked) return route.continue();
    const reason = read ? decision.blocked ? 'known-mutating-read' : 'unreviewed-request' : 'mutating-method';
    trace?.block(request, reason, read && decision.blocked ? decision.code : reason);
    requests.add(request);
    if (read && decision.blocked) counts.blockedMutatingReads++;
    if (hosts.has(new URL(request.url()).hostname)) {
      counts.blockedServiceWrites++;
      if (blocked.length < 30) blocked.push(read ? decision.blocked ? '부작용이 확인된 GET/HEAD 경로를 실행하지 않아 해당 기능은 미검증입니다.' : '승인된 공개 관측 요청 목록에 없어 실행하지 않았습니다.' : `공개 읽기 점검에서 서비스의 ${request.method()} 요청을 차단했습니다.`);
    } else counts.blockedExternalWrites++;
    return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', async socket => {
    if (typeof policy?.routeSocket === 'function') {
      try {
        const verdict = await policy.routeSocket(socket, trace, counts);
        if (verdict?.allowed === true && typeof verdict.effect === 'string') effectsAllowed.add(verdict.effect);
        return;
      } catch { /* A failed custom observation guard falls back to denying the socket. */ }
    }
    trace?.socket(socket.url());
    if (hosts.has(new URL(socket.url()).hostname)) {
      counts.blockedServiceSockets++;
      if (blocked.length < 30) blocked.push('공개 읽기 점검에서 서비스의 WebSocket 연결을 차단했습니다.');
    } else counts.blockedExternalSockets++;
    socket.close();
  });
  return { blocked, requests, counts, effectsAllowed };
}

export async function probe(browser, target, config, screenshotDirectory) {
  config = renderingConfig(config);
  const start = Date.now();
  const result = { ...target, verificationScope: 'render-only', status: 'pending', checkedAt: null, durationMs: 0, httpStatus: null, issues: [], checks: [], screenshot: null };
  const issue = (kind, message) => { if (result.issues.length < 30) result.issues.push({ kind, message: safeMessage(message) }); };
  const context = await browser.newContext({ viewport: { width: target.viewport.width, height: target.viewport.height }, deviceScaleFactor: 1, isMobile: !!target.viewport.isMobile, hasTouch: !!target.viewport.isMobile, locale: target.viewport.locale || config.locale || 'ko-KR', serviceWorkers: 'block', reducedMotion: 'reduce', acceptDownloads: false });
  const trace = createDiagnostics(target, config.diagnosticSampling);
  const networkListeners = { request: request => trace.ensure(request), response: response => trace.response(response), requestfinished: request => trace.finished(request), requestfailed: request => trace.fail(request) };
  for (const [event, listener] of Object.entries(networkListeners)) context.on(event, listener);
  const guard = await installReadOnlyGuard(context, config.origins, trace, config.renderOnly ? { request: request => ({ allowed: renderReadAllowed(request, config.origins), effect: 'resource-read' }) } : config.publicObservationPolicy || null);
  const page = await context.newPage();
  let pixelsAvailable = true;
  const saveCapture = async buffer => {
    if (config.captureScreenshots !== true) {
      result.screenshotOmittedReason = '개인정보 보호를 위해 캡처 파일 저장을 기본으로 생략합니다. 픽셀은 메모리에서만 확인합니다.';
      return;
    }
    try {
      await mkdir(screenshotDirectory, { recursive: true });
      await writeFile(path.join(screenshotDirectory, `${target.id}.png`), buffer);
      result.screenshot = `/screenshots/${path.basename(screenshotDirectory)}/${target.id}.png`;
    } catch {
      result.screenshotOmittedReason = '캡처 파일을 저장하지 못했습니다. 메모리에서 확인한 페이지 판정은 유지됩니다.';
    }
  };
  let fatalEvent;
  const fatal = new Promise(resolve => { fatalEvent = resolve; });
  const rule = { selectors: [], loading: [], errors: [], unknownSelectors: [], ...(target.rule || (config.renderOnly ? renderRuleFor(target.url) : ruleFor(target.url))) };
  const timeout = rule.canvas ? Math.max(config.renderTimeoutMs, config.viewerRenderTimeoutMs ?? 90000) : config.renderTimeoutMs;
  const readiness = { state: 'unverified', selectors: rule.selectors, requiredGlobal: rule.requiredGlobal || null, loading: rule.loading, errorSelectors: rule.errors, elapsedMs: 0 };
  page.on('pageerror', e => { issue('javascript', e.message); fatalEvent(); });
  page.on('crash', () => { issue('browser-crash', '브라우저 탭이 종료됐습니다.'); fatalEvent(); });
  let consoleErrors = 0;
  if (config.renderOnly) page.on('console', event => { if (event.type() === 'error') consoleErrors++; });
  try {
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
    result.httpStatus = response?.status() ?? null;
    if (!response || !response.ok()) issue('http', `페이지 응답: ${result.httpStatus ?? '없음'}`);
    result.finalUrl = page.url();
    if (!config.origins.includes(new URL(result.finalUrl).origin)) issue('redirect', '요청한 서비스 밖으로 이동했습니다.');
    const readyStart = Date.now();
    let policyTimer;
    if (config.renderOnly) policyTimer = setInterval(() => { if (trace.hasBlockedEssential()) fatalEvent(); }, 50);
    try {
      await Promise.race([fatal, page.waitForFunction(({ selectors, loading, errors, unknownSelectors, requiredGlobal }) => {
        const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 && (!el.matches('[data-render-state=empty]') || !!el.textContent.trim()); };
        return [...errors, ...unknownSelectors].some(s => [...document.querySelectorAll(s)].some(visible)) || (selectors.every(s => [...document.querySelectorAll(s)].some(visible)) && loading.every(s => ![...document.querySelectorAll(s)].some(visible)) && (!requiredGlobal || !!window[requiredGlobal]) && (document.body?.innerText.trim().length > 30 || document.querySelector('canvas')));
      }, rule, { timeout })]);
    } catch { issue('render-timeout', `화면 준비 조건을 ${timeout / 1000}초 안에 충족하지 못했습니다.`); }
    clearInterval(policyTimer);
    readiness.elapsedMs = Date.now() - readyStart;
    await page.waitForTimeout(config.settleMs);
    if (config.renderOnly) {
      const media = await observeLazyImages(page);
      for (const url of media.broken) if (trace.visibleMedia(url)) issue('broken-image', safeLocation(url, { sampling: config.diagnosticSampling }).path);
      if (media.pending) issue('media-pending', '관측 구간의 이미지 로딩을 완료하지 못했습니다.');
      const layout = await observeLayout(page, target.viewport.width);
      result.renderDiagnostics = { consoleErrors, lazyViewports: media.viewports, mediaPending: media.pending, layout };
      if (layout.overflow) issue('layout-overflow', '화면 너비를 넘는 가로 레이아웃이 발견됐습니다.');
    }
    result.finalUrl = page.url();
    if (!allowedNavigation(target.url, result.finalUrl)) issue('redirect', '요청한 페이지와 다른 화면으로 이동했습니다.');
    const dom = await page.evaluate(({ selectors, loading, errors, unknownSelectors, requiredGlobal }) => {
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 && (!el.matches('[data-render-state=empty]') || !!el.textContent.trim()); };
      const app = document.querySelector('#app') || document.body;
      return {
        textLength: app.innerText.trim().length,
        visibleElements: [...app.querySelectorAll('h1,h2,p,a,button,input,img,canvas')].filter(visible).length,
        missing: selectors.filter(s => ![...document.querySelectorAll(s)].some(visible)),
        loading: loading.filter(s => [...document.querySelectorAll(s)].some(visible)),
        errors: errors.filter(s => [...document.querySelectorAll(s)].some(visible)),
        brokenImages: [...document.images].filter(el => { const r = el.getBoundingClientRect(); return visible(el) && r.top < innerHeight && r.bottom > 0 && el.complete && !el.naturalWidth; }).map(el => el.currentSrc || el.src).slice(0, 5),
        accessGate: unknownSelectors.some(s => [...document.querySelectorAll(s)].some(visible)),
        globalReady: !requiredGlobal || !!window[requiredGlobal],
        backgrounds: [...app.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return visible(el) && r.top < innerHeight && r.bottom > 0; }).flatMap(el => [...getComputedStyle(el).backgroundImage.matchAll(/url\(["']?(.+?)["']?\)/g)].map(m => m[1])).slice(0, 12),
      };
    }, rule);
    readiness.state = dom.accessGate || rule.unsupported ? 'unverified' : !dom.missing.length && !dom.loading.length && !dom.errors.length && dom.globalReady ? 'ready' : 'failed';
    readiness.observed = { missingSelectors: dom.missing, visibleLoading: dom.loading, visibleErrorSelectors: dom.errors, globalReady: dom.globalReady, accessGate: dom.accessGate };
    if (dom.accessGate) result.issues = result.issues.filter(x => x.kind !== 'render-timeout');
    if (dom.missing.length && !dom.accessGate) issue('required-content', `필수 화면 요소 없음: ${dom.missing.join(', ')}`);
    if (!dom.globalReady && !dom.accessGate) issue('3d-not-ready', '3D 엔진의 준비 완료를 확인하지 못했습니다.');
    if (dom.loading.length && !dom.accessGate) issue('loading', `로딩이 끝나지 않았습니다: ${dom.loading.join(', ')}`);
    for (const message of dom.errors) issue('error-screen', message);
    if (dom.visibleElements < (rule.canvas ? 1 : 2) || (!rule.canvas && dom.textLength < 30)) issue('empty-dom', `본문이 비어 있습니다 (텍스트 ${dom.textLength}자, 화면 요소 ${dom.visibleElements}개).`);
    for (const url of dom.brokenImages) if (trace.visibleMedia(url)) issue('broken-image', safeLocation(url, { sampling: config.diagnosticSampling }).path);
    const brokenBackgrounds = await page.evaluate(async urls => (await Promise.all([...new Set(urls)].map(url => new Promise(resolve => {
      const img = new Image(); const timeout = setTimeout(() => resolve(url), 3000);
      img.onload = () => { clearTimeout(timeout); resolve(null); }; img.onerror = () => { clearTimeout(timeout); resolve(url); }; img.src = url;
    })))).filter(Boolean), dom.backgrounds);
    for (const url of brokenBackgrounds) if (trace.visibleMedia(url)) issue('broken-background', safeLocation(url, { sampling: config.diagnosticSampling }).path);
    try {
      const buffer = await page.screenshot({ fullPage: false, timeout: 15000 });
      const pixels = pixelStats(buffer);
      if (pixels.dominantRatio > 0.997) issue('blank-screen', `화면의 ${(pixels.dominantRatio * 100).toFixed(1)}%가 같은 색입니다.`);
      await saveCapture(buffer);
    } catch {
      pixelsAvailable = false;
      result.screenshotOmittedReason = '캡처를 얻지 못해 실제 화면 픽셀은 미확인입니다. DOM·HTTP·실행 오류 결과만 남깁니다.';
      issue('capture-unavailable', result.screenshotOmittedReason);
    }
    if (rule.canvas && !dom.accessGate) {
      const canvas = page.locator('canvas#unity-canvas').first();
      if (await canvas.isVisible()) {
        try {
          const stats = pixelStats(await canvas.screenshot({ timeout: 10000 }));
          if (stats.dominantRatio > 0.995 || stats.colors < 8) issue('blank-canvas', '3D 캔버스에 실제 장면이 표시되지 않습니다.');
        } catch {
          pixelsAvailable = false;
          issue('capture-unavailable', '3D 캔버스 픽셀을 얻지 못해 실제 장면은 미확인입니다.');
        }
      }
    }
    result.checks = [
      { name: 'HTTP 응답', passed: !!response?.ok() },
      { name: '브라우저 실행', passed: !result.issues.some(x => ['javascript', 'browser-crash'].includes(x.kind)) },
      { name: '필수 화면 요소', passed: rule.unsupported || dom.accessGate ? null : !dom.missing.length && !dom.loading.length && !dom.errors.length && dom.globalReady, detail: rule.selectors.length ? `${rule.selectors.length}개 확인` : '페이지별 검사 기준 미등록' },
      { name: '실제 화면 픽셀', passed: pixelsAvailable ? !result.issues.some(x => ['blank-screen', 'blank-canvas', 'empty-dom'].includes(x.kind)) : null }
    ];
    result.status = result.issues.some(x => x.kind !== 'capture-unavailable') ? 'fail' : !pixelsAvailable || dom.accessGate || rule.unsupported ? 'unknown' : 'pass';
    if (dom.accessGate) issue('access-required', '입장/비밀번호 안내 화면으로 실제 관람 장면은 미확인입니다.');
    if (rule.unsupported) issue('contract', '이 경로의 필수 화면 검사 기준을 등록해야 합니다.');
    if (config.followViewerEntries && !(config.pageSpecificationEnabled === true && config.publicObservationPolicy) && target.group === '전시 프리뷰' && !dom.accessGate && !dom.missing.length && !dom.loading.length && !dom.errors.length) {
      const button = page.locator('.hero__actions .button--hero').first();
      if (await button.isEnabled()) {
        let viewerUrl;
        const isViewer = raw => { const u = new URL(raw); return config.origins.includes(u.origin) && (u.pathname === '/meum-lite-viewer' || /\/viewer(?:\/|$)/.test(u.pathname)); };
        // Capture the public entry URL, then render it separately with a fresh guest context.
        await context.route('**/*', async route => {
          if (route.request().isNavigationRequest() && isViewer(route.request().url())) { viewerUrl = route.request().url(); trace.block(route.request(), 'entry-navigation-not-executed'); await route.abort('aborted'); }
          else await route.fallback();
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
        } else { issue('entry-discovery', '관람 버튼의 실제 목적지를 확인하지 못했습니다.'); if (result.status === 'pass') result.status = 'unknown'; }
      }
    }
    if (result.status === 'pass' && result.issues.some(x => x.kind !== 'capture-unavailable')) result.status = 'fail';
  } catch (e) {
    if (guard.blocked.length && !result.issues.length) {
      issue('read-only-block', '읽기 전용 제한으로 화면 확인을 마치지 못했습니다.'); result.status = 'unknown';
    } else { issue('navigation', e.message); result.status = 'fail'; }
    if (config.captureScreenshots === true) try { await saveCapture(await page.screenshot({ timeout: 5000 })); }
    catch { result.screenshotOmittedReason = '오류 화면의 캡처를 얻지 못했습니다.'; }
  } finally {
    if (typeof config.observePage === 'function') {
      try { result.observation = await config.observePage(page, { target, rule }); }
      catch { result.observation = { status: 'unverified', reason: 'observer-error' }; }
    }
    for (const [event, listener] of Object.entries(networkListeners)) context.off(event, listener);
    if (result.finalUrl) { result.finalLocation = safeLocation(result.finalUrl, { sampling: config.diagnosticSampling }); delete result.finalUrl; }
    result.policy = { readOnly: true, ...guard.counts, ...(config.publicObservationPolicy ? { observationMode: true, readOnlyMeaning: 'content-not-modified; ordinary guest sessions and counters may occur', effectsAllowed: [...guard.effectsAllowed].filter(effect => typeof effect === 'string') } : {}) };
    result.diagnostics = trace.finish(result.issues, readiness, { navigationMs: config.navigationTimeoutMs, readinessMs: timeout });
    if (config.renderOnly && result.diagnostics.groups.some(group => group.cause === 'javascript' && group.severity === 'unknown') && !result.diagnostics.groups.some(group => group.cause === 'javascript' && group.severity === 'failure')) {
      for (const check of result.checks) if (check.name === '브라우저 실행') { check.passed = null; check.detail = '차단된 필수 요청 뒤의 네트워크 예외로 원인이 미확인입니다.'; }
    }
    if (result.diagnostics.readiness.state === 'blocked') for (const check of result.checks) if (check.name === '필수 화면 요소') { check.passed = null; check.detail = '필수 사전 요청을 안전 정책으로 실행하지 못했습니다.'; }
    for (const group of result.diagnostics.groups) {
      if (group.cause === 'http-resource' && group.severity === 'failure') issue('http-resource', '등록된 필수 리소스의 오류 응답입니다. 요청별 상태와 시각을 확인하세요.');
      if (group.cause === 'policy-block' && group.severity !== 'warning') issue('read-only-block', '안전 정책 때문에 실행하지 않은 요청입니다. 요청별 차단 사유를 확인하세요.');
    }
    result.status = result.diagnostics.groups.some(group => group.severity === 'failure') ? 'fail' : !pixelsAvailable || rule.unsupported || result.diagnostics.groups.some(group => ['blocked', 'unknown'].includes(group.severity)) || readiness.state !== 'ready' ? 'unknown' : 'pass';
    result.checkedAt = new Date().toISOString(); result.durationMs = Date.now() - start;
    await context.close().catch(() => {});
  }
  return result;
}
