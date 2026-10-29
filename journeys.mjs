import { contractFor, evaluateDestination, JOURNEY_MODES } from './journey-contracts.mjs';
import { readPolicyDecision } from './read-only-policy.mjs';

class Blocked extends Error {}
const safeUrl = value => {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) if (!['page', 'p', 'query', 'sort', 'locale', 'r', 'meum_share', 'meum_entry', 'meum_entry_room', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].includes(key)) url.searchParams.set(key, '[omitted]');
    url.hash = '';
    return url.href;
  } catch { return ''; }
};

export function summarizeCases(cases) {
  const required = cases.filter(item => item.required !== false);
  if (required.some(item => item.status === 'fail')) return 'fail';
  if (required.some(item => item.status === 'blocked')) return 'blocked';
  if (required.some(item => item.status === 'unregistered')) return 'unregistered';
  if (!required.length || required.some(item => item.status === 'not-run')) return 'not-run';
  return required.every(item => item.status === 'pass') ? 'pass' : 'blocked';
}

async function firstVisible(page, selector) {
  if (!selector) throw new Blocked('No action selector is registered');
  for (const locator of await page.locator(selector).all()) if (await locator.isVisible()) return locator;
  throw new Blocked(`Required guest action is not visible: ${selector}`);
}

async function click(page, selector, reveal) {
  let locator;
  try { locator = await firstVisible(page, selector); }
  catch (error) { if (!reveal) throw error; await (await firstVisible(page, reveal)).click(); locator = await firstVisible(page, selector); }
  if (!await locator.isEnabled()) throw new Blocked('The action is disabled for this exhibition or role');
  await locator.click({ noWaitAfter: true });
}

async function observe(page) {
  return { url: safeUrl(page.url()), ...await page.evaluate(() => ({ language: document.documentElement.lang || '', vueMounted: !!document.querySelector('#app')?.__vue_app__ })) };
}

async function ready(page, readiness, timeout) {
  const contract = { selectors: [], loading: [], errors: [], gates: [], ...readiness };
  const result = await page.waitForFunction(({ selectors, loading, errors, gates, requiredGlobal }) => {
    const visible = selector => [...document.querySelectorAll(selector)].some(element => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
    });
    if (gates.some(visible)) return 'gate';
    if (errors.some(visible)) return 'error';
    return selectors.length && selectors.every(visible) && !loading.some(visible) && (!requiredGlobal || !!window[requiredGlobal]) ? 'ready' : false;
  }, contract, { timeout });
  const state = await result.jsonValue();
  await result.dispose();
  if (state === 'gate') throw new Blocked('A password, login or exhibition entry gate prevents guest completion');
  if (state === 'error') throw new Error('The destination shows an application error');
  const textMatches = await page.evaluate(checks => checks.every(check => [...document.querySelectorAll(check.selector)].some(element => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && element.textContent.replace(/\s+/g, ' ').includes(check.includes);
  })), contract.textChecks || []);
  if (!textMatches) throw new Error('Visible page labels do not match the intended language contract');
}

function ensureDestination(expected, observed, sourceUrl, checks) {
  const evaluation = evaluateDestination(expected, observed, { sourceUrl });
  checks.push({ name: 'destination-and-language', passed: evaluation.passed, detail: evaluation.reason });
  if (!evaluation.passed) throw new Error(evaluation.reason);
}

async function instrument(context, language, shareMode, blockedRequests, allowedOrigins) {
  await context.route('**/*', async route => {
    const request = route.request();
    if (request.isNavigationRequest() && request.resourceType() === 'document' && !allowedOrigins.has(new URL(request.url()).origin)) return route.abort('blockedbyclient');
    const mutatingRead = ['GET', 'HEAD'].includes(request.method()) && readPolicyDecision(request.url()).blocked;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || mutatingRead) {
      blockedRequests.push({ method: request.method(), url: safeUrl(request.url()), ...(mutatingRead ? { kind: 'mutating-read' } : {}) });
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  });
  if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => socket.close());
  await context.addInitScript(({ language, shareMode }) => {
    window.__journeyEvidence = { copies: [], shares: [], opened: [] };
    try { localStorage.setItem('meum:web:locale', language); } catch {}
    const evidence = window.__journeyEvidence;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { evidence.copies.push(String(value)); } } });
    Object.defineProperty(navigator, 'share', { configurable: true, value: shareMode === 'cancel' ? async value => { evidence.shares.push({ url: value?.url }); throw new DOMException('Cancelled by local monitor fixture', 'AbortError'); } : undefined });
    window.open = url => { evidence.opened.push(new URL(url, location.href).href); return null; };
  }, { language, shareMode });
}

export async function runJourneys(browser, target, config = {}) {
  const contract = contractFor(target, config);
  const result = { required: true, status: 'unregistered', evidenceScope: 'public-instrumented', contractId: contract?.id || null, preconditions: contract ? { role: 'fresh-guest', intendedLanguage: contract.language, isolatedSiteLanguagePreference: contract.language, browserLocale: contract.language === 'en' ? 'en-US' : 'ko-KR', customerWrites: 'blocked' } : null, cases: [] };
  if (!contract) { result.reason = 'No public guest journey is registered for this page'; return result; }
  if (contract.role !== 'guest') { result.status = 'blocked'; result.reason = 'Public journeys only support a fresh guest context'; return result; }
  const registeredModes = contract.modes || JOURNEY_MODES;
  const modes = config.journeyModes || registeredModes;
  result.scope = { registeredModes, selectedModes: modes };
  result.partialScope = registeredModes.some(mode => !modes.includes(mode));
  const hasCancelableAction = contract.actions?.some(action => ['overlay', 'search'].includes(action.kind));
  for (const mode of registeredModes.filter(mode => !modes.includes(mode))) {
    const applicable = !(['cancel', 'repeat'].includes(mode) && !hasCancelableAction) && !(mode === 'actions' && !contract.actions?.length);
    result.cases.push({ id: mode, name: mode, required: applicable, role: 'guest', mode, viewport: mode === 'mobile' ? 'mobile' : target.viewport?.name || 'desktop', status: 'not-run', reason: applicable ? 'This registered mode was not selected for this run' : 'This mode has no applicable action in the registered contract', checks: [], observed: null });
  }
  const timeout = config.journeyTimeoutMs || config.renderTimeoutMs || 10000;
  const navigationTimeout = config.navigationTimeoutMs || timeout;
  const allowedOrigins = new Set(config.origins || [new URL(target.url).origin]);
  const requireAllowed = url => { if (!allowedOrigins.has(new URL(url).origin)) throw new Blocked('Destination is outside the configured public origins'); };

  const runCase = async (id, name, mode, operation, { required = true, mobile = false, shareMode = 'copy' } = {}) => {
    const viewport = mobile ? { name: 'mobile', width: 390, height: 844, isMobile: true } : { name: 'desktop', width: 1440, height: 1000, ...target.viewport };
    const item = { id, name, required, role: 'guest', mode, viewport: viewport.name, status: 'not-run', reason: null, checks: [], observed: null };
    result.cases.push(item);
    let context, page;
    const denied = [], runtimeErrors = [];
    try {
      requireAllowed(contract.url);
      context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: !!viewport.isMobile, hasTouch: !!viewport.isMobile, locale: contract.language === 'en' ? 'en-US' : 'ko-KR', serviceWorkers: 'block' });
      await instrument(context, contract.language, shareMode, denied, allowedOrigins);
      page = await context.newPage();
      page.setDefaultTimeout(timeout);
      page.on('pageerror', error => runtimeErrors.push(error.message));
      page.on('dialog', dialog => { void dialog.dismiss(); });
      const load = async (url = contract.url, readiness = contract.ready) => {
        requireAllowed(url);
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
        if (!response?.ok()) throw new Error(`Navigation HTTP ${response?.status() || 'unavailable'}`);
        if (readiness?.requireVueMounted ?? contract.requireVueMounted) await page.waitForFunction(() => !!document.querySelector('#app')?.__vue_app__, null, { timeout });
        try { await ready(page, readiness, timeout); }
        catch (error) {
          const necessaryWrite = denied.some(request => readiness?.blockedRequestPaths?.includes(new URL(request.url).pathname));
          if (necessaryWrite) throw new Blocked('The read-only guest guard blocked a specifically required destination API');
          throw error;
        }
      };
      await operation({ page, context, item, load, denied });
      if (runtimeErrors.length) throw new Error('A JavaScript exception occurred during the journey');
      item.status = 'pass';
    } catch (error) {
      item.status = error instanceof Blocked ? 'blocked' : 'fail';
      item.reason = error instanceof Blocked ? error.message : String(error.message).slice(0, 500);
      if (!item.observed && page) { try { item.observed = await observe(page); } catch {} }
    } finally {
      if (denied.length) item.blockedWriteRequests = denied.slice(0, 10);
      await context?.close().catch(() => {});
    }
    return item;
  };

  const verifySource = async (page, item) => {
    item.observed = await observe(page);
    ensureDestination({ ...contract.expected, language: contract.language }, item.observed, contract.url, item.checks);
  };
  const navigateInternal = async ({ page, item, load }) => {
    if (!contract.internal) throw new Blocked('An internal SPA action has not been registered for this page');
    const internal = contract.internal;
    if (internal.from) await load(internal.from, internal.fromReady || { selectors: ['main h1'], errors: [], loading: [] });
    else await load();
    await page.evaluate(() => { window.__journeyDocumentIdentity = Math.random(); });
    const documentIdentity = await page.evaluate(() => window.__journeyDocumentIdentity);
    await click(page, internal.selector, internal.reveal);
    await page.waitForURL(url => evaluateDestination({ ...internal.expected, language: undefined }, { url: url.href }, { sourceUrl: contract.url }).passed, { timeout });
    await ready(page, internal.ready || contract.ready, timeout);
    item.observed = await observe(page);
    ensureDestination({ ...internal.expected, language: contract.language }, item.observed, contract.url, item.checks);
    const sameDocument = await page.evaluate(value => window.__journeyDocumentIdentity === value, documentIdentity);
    item.checks.push({ name: 'same-document-SPA-navigation', passed: sameDocument });
    if (!sameDocument) throw new Error('The internal action replaced the document instead of using the registered SPA route');
  };
  const overlay = async (page, action, item, repetitions = 1) => {
    const source = page.url();
    for (let index = 0; index < repetitions; index++) {
      await click(page, action.selector);
      await page.locator(action.opened).first().waitFor({ state: 'visible' });
      if (action.interactive) await page.locator(action.interactive).first().waitFor({ state: 'visible' });
      const openCount = await page.locator(action.opened).count();
      if (openCount !== 1) throw new Error('An artwork action created duplicate overlays');
      await click(page, action.close);
      await page.locator(action.opened).waitFor({ state: 'hidden' });
      if (page.url() !== source) throw new Error('Closing an artwork unexpectedly navigated away from its source');
    }
    item.checks.push({ name: 'artwork-open-close', passed: true, repetitions });
  };
  const search = async (page, action, item, cancel = false, repetitions = 1) => {
    if (!action.request || !action.results) throw new Blocked('A response-to-rendered-results contract has not been registered');
    const baseline = new URL(page.url()).searchParams.get(action.queryKey);
    const verifyResults = async payload => {
      if (action.expectedId && !payload.result.some(row => String(row.id) === String(action.expectedId) && (row.source_type || 'room') === action.expectedSourceType)) throw new Error('The known baseline exhibition was not returned by its own title search');
      const rows = payload.result.map(row => {
        let detail = row.detail;
        if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch { detail = {}; } }
        const path = row.source_type === 'oneday' ? `/oneday/${row.id}` : `/exhibition/preview/${row.id}`;
        if (!(row.source_type === 'oneday' ? /^[a-zA-Z0-9_-]+$/ : /^[1-9]\d*$/).test(String(row.id))) throw new Error('Search response has an invalid exhibition identity');
        return { path, title: String(detail?.title || (contract.language === 'en' ? 'Untitled' : '무제')).trim() };
      });
      const resultContract = action.results;
      await page.waitForFunction(({ cards, title, empty, expected }) => {
        const visible = element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
        const actual = [...document.querySelectorAll(cards)].filter(visible);
        if (!expected.length) return actual.length === 0 && [...document.querySelectorAll(empty)].some(visible);
        return actual.length === expected.length && actual.every((card, index) => card.querySelector(title)?.textContent.trim() === expected[index].title);
      }, { ...resultContract, expected: rows }, { timeout });
      const source = page.url();
      // Cards expose no room ID attribute in the real UI. Actual clicks prove each response ID.
      for (let index = 0; index < rows.length; index++) {
        const card = page.locator(resultContract.cards).nth(index);
        const opener = resultContract.open ? card.locator(resultContract.open) : card;
        await opener.click();
        await page.waitForURL(url => url.origin === new URL(source).origin && url.pathname.replace(/\/+$/, '') === rows[index].path, { timeout });
        await ready(page, { selectors: [resultContract.destinationTitle] }, timeout);
        const title = await page.locator(resultContract.destinationTitle).first().textContent();
        if (title.trim() !== rows[index].title) throw new Error('The clicked search card opened another exhibition');
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: navigationTimeout });
        await page.waitForURL(source, { timeout });
        await page.locator(action.ready).first().waitFor({ state: 'visible' });
        const restored = await page.locator(resultContract.cards).count();
        if (restored !== rows.length) throw new Error('Returning from an exhibition lost the filtered search results');
      }
      item.checks.push({ name: 'response-identities-match-rendered-results', passed: true, count: rows.length, identityEvidence: rows.length ? 'actual-card-click-destinations' : 'explicit-empty-state' });
    };
    const submit = async value => {
      // Subscribe before clicking so a fast cached response cannot be missed.
      const responsePromise = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.origin === (action.request.origin || new URL(contract.url).origin) && url.pathname === action.request.path && (url.searchParams.get(action.request.queryKey) || '') === value;
      }, { timeout });
      responsePromise.catch(() => {});
      await click(page, action.submit);
      const response = await responsePromise;
      if (!response.ok()) throw new Error(`Search result HTTP ${response.status()}`);
      const payload = await response.json();
      if (payload.success !== true || !Array.isArray(payload.result) || !Number.isSafeInteger(Number(payload.fullRoomCount)) || Number(payload.fullRoomCount) < payload.result.length) throw new Error('Search did not return a successful result set with a consistent count');
      await page.waitForURL(url => (url.searchParams.get(action.queryKey) || '') === value, { timeout });
      await page.locator(action.ready).first().waitFor({ state: 'visible' });
      await verifyResults(payload);
      item.checks.push({ name: 'search-result-response', passed: true });
    };
    for (let index = 0; index < repetitions; index++) {
      await (await firstVisible(page, action.selector)).fill(action.term);
      // Repeating an unchanged search may intentionally reuse already confirmed results.
      if (index > 0) {
        await (await firstVisible(page, action.selector)).fill('');
        await submit('');
        await page.waitForURL(url => !url.searchParams.has(action.queryKey), { timeout });
        await (await firstVisible(page, action.selector)).fill(action.term);
      }
      await submit(action.term);
      await page.waitForURL(url => url.searchParams.get(action.queryKey) === action.term, { timeout });
      await page.locator(action.ready).first().waitFor({ state: 'visible' });
      if (await (await firstVisible(page, action.selector)).inputValue() !== action.term) throw new Error('Search input does not reflect the active query');
    }
    if (cancel) {
      await (await firstVisible(page, action.selector)).fill(baseline || '');
      await submit(baseline || '');
      await page.waitForURL(url => (url.searchParams.get(action.queryKey) || null) === (baseline || null), { timeout });
      await page.locator(action.ready).first().waitFor({ state: 'visible' });
    }
    item.checks.push({ name: cancel ? 'search-and-restore' : 'search-query-and-results', passed: true, repetitions });
  };

  for (const mode of modes) {
    if (!JOURNEY_MODES.includes(mode)) {
      result.cases.push({ id: mode, name: mode, required: true, role: 'guest', mode, viewport: target.viewport?.name || 'desktop', status: 'unregistered', reason: 'This journey mode is not registered', checks: [], observed: null });
      continue;
    }
    if (mode === 'direct') await runCase('direct', 'Open the intended public page directly', mode, async ({ page, item, load }) => { await load(); await verifySource(page, item); });
    if (mode === 'reload') await runCase('reload', 'Reload the intended public page', mode, async ({ page, item, load }) => { await load(); const response = await page.reload({ waitUntil: 'domcontentloaded', timeout: navigationTimeout }); if (!response?.ok()) throw new Error('Reload did not return a successful response'); if (contract.requireVueMounted) await page.waitForFunction(() => !!document.querySelector('#app')?.__vue_app__, null, { timeout }); await ready(page, contract.ready, timeout); await verifySource(page, item); });
    if (mode === 'spa-internal') await runCase('spa-internal', 'Click an internal route and verify its destination', mode, navigateInternal);
    if (mode === 'history') await runCase('history', 'Use back and forward after an internal action', mode, async environment => {
      const { page, item } = environment;
      await navigateInternal(environment);
      const destination = await observe(page);
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: navigationTimeout });
      const sourceUrl = contract.internal.from || contract.url;
      await page.waitForURL(url => url.pathname === new URL(sourceUrl).pathname, { timeout });
      const sourceReadiness = contract.internal.from ? contract.internal.fromReady || { selectors: ['main h1'] } : contract.ready;
      await ready(page, sourceReadiness, timeout);
      ensureDestination({ path: new URL(sourceUrl).pathname, language: contract.language }, await observe(page), contract.url, item.checks);
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: navigationTimeout });
      await page.waitForURL(url => url.pathname === new URL(destination.url).pathname, { timeout });
      await ready(page, contract.internal.ready || contract.ready, timeout);
      ensureDestination({ ...contract.internal.expected, language: contract.language }, await observe(page), contract.url, item.checks);
      item.observed = { backAndForwardCompleted: true, url: destination.url, language: destination.language };
    });
    if (['cancel', 'repeat', 'mobile'].includes(mode)) {
      const action = contract.actions?.find(action => ['overlay', 'search'].includes(action.kind));
      if (!action && mode !== 'mobile') { result.cases.push({ id: mode, name: mode, required: false, role: 'guest', mode, viewport: target.viewport?.name || 'desktop', status: 'not-run', reason: 'No applicable read-only cancel or repeat action is registered', checks: [], observed: null }); continue; }
      await runCase(mode, `${mode} guest interaction`, mode, async ({ page, item, load }) => {
        await load(); await verifySource(page, item);
        if (action?.kind === 'overlay') await overlay(page, action, item, mode === 'repeat' ? 2 : 1);
        else if (action?.kind === 'search') await search(page, action, item, mode === 'cancel', mode === 'repeat' ? 2 : 1);
        else if (mode === 'mobile') await navigateInternal({ page, item, load });
      }, { mobile: mode === 'mobile' });
    }
    if (mode === 'actions' && !contract.actions?.length) result.cases.push({ id: 'actions', name: 'Registered page actions', required: false, role: 'guest', mode, viewport: target.viewport?.name || 'desktop', status: 'not-run', reason: 'No public page-specific actions are registered', checks: [], observed: null });
    if (mode === 'actions') for (const action of contract.actions || []) {
      let generatedEntry;
      await runCase(action.id, action.name, mode, async ({ page, item, load }) => {
        await load(); await verifySource(page, item);
        if (action.kind === 'overlay') return overlay(page, action, item);
        if (action.kind === 'search') return search(page, action, item, true);
        if (!['share', 'entry'].includes(action.kind)) throw new Blocked('No safe implementation is registered for this action');
        const beforeAction = page.url();
        await click(page, action.selector);
        if (action.kind === 'share') {
          await page.waitForFunction(() => window.__journeyEvidence.copies.length > 0, null, { timeout });
          const generated = await page.evaluate(() => window.__journeyEvidence.copies.at(-1));
          item.observed = { url: safeUrl(generated), scope: 'generated-share-url', nativeShareSucceeded: false };
          ensureDestination(action.expected, { url: generated }, contract.url, item.checks);
        } else {
          await page.waitForFunction(source => window.__journeyEvidence.opened.length > 0 || location.href !== source, beforeAction, { timeout });
          const captured = await page.evaluate(() => window.__journeyEvidence.opened.at(-1));
          const candidate = captured || page.url();
          item.observed = { url: safeUrl(candidate), scope: 'entry-url-generation', destinationVisited: false };
          ensureDestination(action.expected, { url: candidate }, contract.url, item.checks);
          generatedEntry = candidate;
        }
      });
      if (action.kind === 'entry') await runCase(`${action.id}-arrival`, 'Verify the entry destination actually loads for a guest', mode, async ({ page, item, load }) => {
        if (!generatedEntry) throw new Blocked('The entry button did not produce a verified destination');
        if (!action.arrival?.selectors?.length) throw new Blocked('The entry destination render contract is not registered');
        await load(generatedEntry, action.arrival);
        item.observed = { ...await observe(page), scope: 'entry-arrival', destinationVisited: true };
        ensureDestination({ ...action.expected, language: action.arrival.language || contract.language }, item.observed, contract.url, item.checks);
        item.checks.push({ name: 'required-arrival-content', passed: true });
      });
      if (action.kind === 'search') await runCase(`${action.id}-known-positive`, 'Find a known public exhibition by its baseline title', mode, async ({ page, item, load }) => {
        const baselineUrl = new URL(contract.url);
        baselineUrl.searchParams.delete(action.queryKey);
        baselineUrl.searchParams.delete('p');
        baselineUrl.searchParams.set('page', '1');
        const baselineResponse = page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.origin === (action.request.origin || baselineUrl.origin) && url.pathname === action.request.path && !url.searchParams.get(action.request.queryKey);
        }, { timeout });
        baselineResponse.catch(() => {});
        await load(baselineUrl.href);
        const response = await baselineResponse;
        if (!response.ok()) throw new Error('Could not load the public baseline search results');
        const payload = await response.json();
        if (payload.success !== true || !Array.isArray(payload.result)) throw new Error('Public baseline results are invalid');
        const known = payload.result.map(row => {
          let detail = row.detail;
          if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch { detail = {}; } }
          return { id: row.id, sourceType: row.source_type || 'room', title: String(detail?.title || '').trim() };
        }).find(row => row.title);
        if (!known) throw new Blocked('No existing public baseline exhibition is available to prove a positive search');
        await search(page, { ...action, term: known.title, expectedId: known.id, expectedSourceType: known.sourceType }, item);
        item.observed = { scope: 'known-positive-search', expectedBaselineIdentityFound: true };
      });
    }
  }
  const share = contract.actions?.find(action => action.kind === 'share');
  if (modes.includes('cancel') && share) await runCase('share-cancel', 'Cancel instrumented sharing and remain on the same page', 'cancel', async ({ page, item, load }) => {
    await load(); await verifySource(page, item);
    const before = page.url();
    await click(page, share.selector);
    await page.waitForFunction(() => window.__journeyEvidence.shares.length > 0, null, { timeout });
    const generated = await page.evaluate(() => window.__journeyEvidence.shares.at(-1)?.url);
    ensureDestination({ ...share.expected, query: { ...share.expected?.query, meum_share: 'native_share' } }, { url: generated }, contract.url, item.checks);
    await page.waitForTimeout(Math.min(100, timeout));
    if (page.url() !== before) throw new Error('Cancelling sharing navigated away from the exhibition');
    const failedAlert = await page.locator('.modal .title').allTextContents();
    if (failedAlert.some(text => /실패|못했습니다|failed/i.test(text))) throw new Error('Normal share cancellation was presented as an error');
    item.checks.push({ name: 'instrumented-share-cancel', passed: true });
    item.observed = { scope: 'instrumented-platform-cancellation', nativeShareSucceeded: false, remainedOnSource: true };
  }, { shareMode: 'cancel' });
  result.status = summarizeCases(result.cases);
  return result;
}
