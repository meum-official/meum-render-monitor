import assert from 'node:assert/strict';
import { after, before, describe, it, test } from 'node:test';
import { createServer } from 'node:http';
import { contractFor, encodePublicRoomId, evaluateDestination } from '../journey-contracts.mjs';
import { runJourneys, summarizeCases } from '../journeys.mjs';

test('destination contracts enforce the intended language, origin, route and generated query', () => {
  const korean = { path: '/plan', language: 'ko' };
  const options = { sourceUrl: 'https://meum.me/plan' };
  assert.equal(evaluateDestination(korean, { url: 'https://meum.me/plan', language: 'ko-KR' }, options).passed, true);
  assert.equal(evaluateDestination(korean, { url: 'https://meum.me/en/pricing', language: 'en-US' }, options).passed, false);
  assert.equal(evaluateDestination(korean, { url: 'https://meum.me/plan', language: 'en-US' }, options).passed, false);
  assert.equal(evaluateDestination(korean, { url: 'https://other.test/plan', language: 'ko' }, options).passed, false);
  assert.equal(evaluateDestination({ path: '/en/pricing', language: 'en' }, { url: 'https://meum.me/en/pricing', language: 'en-US' }, options).passed, true);
  const share = { path: '/exhibition/preview/1', query: { meum_share: 'copy_link', meum_entry: null } };
  assert.equal(evaluateDestination(share, { url: 'https://meum.me/exhibition/preview/1?meum_share=copy_link' }, options).passed, true);
  assert.equal(evaluateDestination(share, { url: 'https://meum.me/exhibition/preview/2?meum_share=copy_link' }, options).passed, false);
  assert.equal(evaluateDestination(share, { url: 'https://meum.me/exhibition/preview/1?meum_share=copy_link&meum_entry=direct_viewer' }, options).passed, false);
});

test('public guest contracts are explicit and fixture overrides cannot modify production journeys', () => {
  const ko = contractFor({ url: 'https://meum.me/plan' }, { journeyLanguage: 'ko' });
  const en = contractFor({ url: 'https://meum.me/plan' }, { journeyLanguage: 'en' });
  assert.equal(ko.expected.path, '/plan');
  assert.equal(en.expected.path, '/en/pricing');
  assert.equal(contractFor({ url: 'https://meum.me/en/pricing' }, { journeyLanguage: 'ko' }).language, 'en');
  assert.equal(contractFor({ url: 'https://meum.me/en/pricing', expectedLanguage: 'ko' }, { journeyLanguage: 'en' }).language, 'ko');
  const preview = contractFor({ url: 'https://meum.me/exhibition/preview/1' });
  assert.equal(preview.role, 'guest');
  assert.ok(preview.actions.some(action => action.kind === 'entry' && action.arrival.selectors.length));
  assert.equal(contractFor({ url: 'https://meum.me/unknown' }), null);
  assert.equal(contractFor({ url: 'https://meum.me/plan', journeyContract: { id: 'unsafe-override' } }), null);
  assert.equal(contractFor({ url: 'https://account:password@meum.me/plan' }), null);
  assert.equal(contractFor({ url: 'http://127.0.0.1:1234/fixture', journeyContract: { id: 'escaped', url: 'https://meum.me/plan' } }), null);
  assert.equal(contractFor({ url: 'http://127.0.0.1:1234/fixture', journeyContract: { id: 'fixture' } }).id, 'fixture');
  const entry = contractFor({ url: 'https://meum.me/exhibition/preview/4348' }).actions.find(action => action.kind === 'entry').expected;
  const hash = encodePublicRoomId(4348), wrongHash = encodePublicRoomId(4350);
  assert.equal(hash, '4Q8xmY');
  assert.equal(wrongHash, 'aX9ROo');
  const viewer = value => ({ url: `https://meum.me/meum-lite-viewer?r=${value}&meum_entry_room=${value}&meum_entry=introduction` });
  assert.equal(evaluateDestination(entry, viewer(hash), { sourceUrl: 'https://meum.me/exhibition/preview/4348' }).passed, true);
  assert.equal(evaluateDestination(entry, viewer(wrongHash), { sourceUrl: 'https://meum.me/exhibition/preview/4348' }).passed, false);
  assert.equal(evaluateDestination(entry, { url: `https://meum.me/meum-lite-viewer?r=${hash}&meum_entry_room=${wrongHash}&meum_entry=introduction` }, { sourceUrl: 'https://meum.me/exhibition/preview/4348' }).passed, false);
  assert.equal(evaluateDestination(entry, { url: 'https://archive.meum.me/archive/viewer/4350?meum_entry=introduction' }, { sourceUrl: 'https://meum.me/exhibition/preview/4348' }).passed, false);
});

test('partial and unperformed required cases never aggregate to pass', () => {
  const row = status => ({ status, required: true });
  assert.equal(summarizeCases([row('pass'), row('blocked')]), 'blocked');
  assert.equal(summarizeCases([row('pass'), row('not-run')]), 'not-run');
  assert.equal(summarizeCases([row('unregistered')]), 'unregistered');
  assert.equal(summarizeCases([]), 'not-run');
  assert.equal(summarizeCases([row('pass'), row('fail')]), 'fail');
});

const fixtureHTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>body{font:18px system-ui;margin:24px}button,a,input{display:inline-block;min-height:44px;margin:6px;padding:8px}main{max-width:800px}.artwork-focus-overlay{position:fixed;inset:0;background:#ddd;padding:40px}</style></head><body><main id="app" data-v-app></main><script>
const fault = new URL(location.href).searchParams.get('fault') || '';
const initialRows = [{id:101,detail:{title:'Fixture result one'},source_type:'room'}];
let resultRows = initialRows;
const queryFor = () => fault ? '?fault=' + encodeURIComponent(fault) : '';
function navigate(path) { history.pushState({}, '', path); render(); }
function render() {
  const path = location.pathname;
  document.documentElement.lang = path === '/en/pricing' || fault === 'english' ? 'en-US' : 'ko-KR';
  const main = document.querySelector('main');
  if (path === '/preview') main.innerHTML = '<h1>Fixture exhibition preview</h1><p>Public read-only exhibition journey fixture.</p><a id="to-list" href="' + (fault === 'wrong-destination' ? '/wrong' : '/list') + queryFor() + '" data-route>Exhibition list</a><button id="artwork">Open artwork</button><button id="share">Share exhibition</button><button id="enter">Enter exhibition</button>';
  else if (path === '/list') { const rendered = ['stale-card','empty-wrong'].includes(fault) ? initialRows : resultRows; main.innerHTML = '<h1>Fixture public exhibition list</h1><a id="to-preview" href="/preview' + queryFor() + '" data-route>Open preview</a><form id="search-form"><input id="search" value="' + (new URL(location.href).searchParams.get('query') || '') + '"><button id="search-submit">Search</button></form><section id="results" aria-busy="false">' + (rendered.length ? rendered.map(row => '<article class="result-card"><a class="result-open" href="/exhibition/preview/' + (fault === 'wrong-card' ? 202 : row.id) + queryFor() + '" data-route><span class="result-title">' + row.detail.title + '</span></a></article>').join('') : '<div class="none-item" role="status">No matching public exhibitions</div>') + '</section>'; }
  else if (path.startsWith('/exhibition/preview/')) main.innerHTML = '<h1 id="result-heading">' + (path.endsWith('/101') ? (fault === 'stale-card' ? 'Fresh fixture result' : 'Fixture result one') : 'Another exhibition') + '</h1>';
  else if (path === '/viewer' || path === '/write-viewer') { main.innerHTML = '<h1>Fixture exhibition viewer</h1><p>Guest arrival page</p>' + (path === '/viewer' ? '<div id="viewer-ready">Scene ready</div>' : ''); if (path === '/write-viewer') fetch('/customer-write', { method: 'POST', body: 'must-never-reach-server' }).then(() => { main.innerHTML += '<div id="viewer-ready">Scene ready</div>'; }).catch(() => { main.innerHTML += '<div role="alert">A write was required</div>'; }); }
  else if (path === '/plan') main.innerHTML = '<section class="plan-select"><h1 class="pricing-hero__title">' + (fault === 'forged-language' ? 'Bring your school art show online.' : '우리 학교 미술전, 온라인에서도 열어보세요.') + '</h1><h2 id="group-plans-title">' + (fault === 'forged-language' ? 'What kind of exhibition are you planning?' : '어떤 전시를 준비하고 계신가요?') + '</h2></section>';
  else if (path === '/en/pricing') main.innerHTML = '<h1>English pricing</h1><p>English pricing fixture</p>';
  else main.innerHTML = '<h1>Fixture home</h1><a id="to-list" href="/list" data-route>Browse exhibitions</a><a id="to-plan" href="/plan" data-route>Pricing</a>';
}
addEventListener('popstate', render);
document.addEventListener('click', async event => {
  const route = event.target.closest('[data-route]');
  if (route) { event.preventDefault(); navigate(route.getAttribute('href')); return; }
  if (event.target.id === 'artwork') { const dialog = document.createElement('section'); dialog.className = 'artwork-focus-overlay is-opening'; dialog.setAttribute('role', 'dialog'); dialog.innerHTML = '<h2>Fixture artwork</h2>' + (fault === 'missing-close' ? '' : '<button id="close-artwork">Close artwork</button>'); document.body.append(dialog); setTimeout(() => dialog.classList.remove('is-opening'), 100); }
  if (event.target.id === 'close-artwork' && !document.querySelector('.artwork-focus-overlay').classList.contains('is-opening')) document.querySelector('.artwork-focus-overlay').remove();
  if (event.target.id === 'enter') { const hash = fault === 'wrong-room' ? 'aX9ROo' : '4Q8xmY'; window.open((fault === 'needs-write' ? '/write-viewer' : '/viewer') + '?r=' + hash + '&meum_entry_room=' + hash + '&meum_entry=introduction', '_blank'); }
  if (event.target.id === 'share') { const url = new URL(location.href); if (fault === 'wrong-share') url.pathname = '/wrong'; url.searchParams.set('meum_share', navigator.share ? 'native_share' : 'copy_link'); try { if (navigator.share) await navigator.share({url:url.href}); else await navigator.clipboard.writeText(url.href); } catch (error) { if (error.name !== 'AbortError') throw error; } }
});
document.addEventListener('submit', async event => { if (event.target.id !== 'search-form') return; event.preventDefault(); const value = document.querySelector('#search').value; if (fault !== 'stale-search') { const response = await fetch('/room/list?query=' + encodeURIComponent(value) + '&fault=' + fault); resultRows = (await response.json()).result; } const url = new URL(location.href); if (value) url.searchParams.set('query', value); else url.searchParams.delete('query'); navigate(url.pathname + url.search); });
render();
if (location.pathname === '/list') fetch('/room/list?query=' + encodeURIComponent(new URL(location.href).searchParams.get('query') || '') + '&fault=' + fault).then(response => response.json()).then(payload => { resultRows = payload.result; render(); });
if (fault === 'hydrate-later') setTimeout(() => { document.querySelector('#app').__vue_app__ = {}; }, 100);
if (fault === 'telemetry-only') fetch('/telemetry', {method:'POST'}).catch(() => {});
</script></body></html>`;

describe('instrumented public journeys against local fixtures only', { skip: process.env.RUN_BROWSER_TESTS !== '1', concurrency: false }, () => {
  let browser, server, origin;
  let receivedWrites = 0;
  let viewerReads = 0;
  before(async () => {
    server = createServer((request, response) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) receivedWrites++;
      if (new URL(request.url, 'http://localhost').pathname === '/viewer') viewerReads++;
      if (new URL(request.url, 'http://localhost').pathname === '/room/list') {
        const fault = new URL(request.url, 'http://localhost').searchParams.get('fault');
        const query = new URL(request.url, 'http://localhost').searchParams.get('query') || '';
        const rows = fault?.startsWith('empty-') || (fault === 'always-empty-search' && query) ? [] : [{ id: 101, detail: { title: fault === 'stale-card' ? 'Fresh fixture result' : 'Fixture result one' }, source_type: 'room' }];
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true, result: rows, fullRoomCount: rows.length }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(fixtureHTML);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    const { launchBrowser } = await import('../probe.mjs');
    browser = await launchBrowser();
  });
  after(async () => {
    await browser?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
  });
  const config = () => ({ origins: [origin], journeyTimeoutMs: 2000, navigationTimeoutMs: 3000 });
  const previewContract = () => ({
    id: 'fixture-preview', page: 'exhibition-preview', role: 'guest', language: 'ko', expected: { path: '/preview', language: 'ko' },
    ready: { selectors: ['main h1', '#artwork'], loading: [], errors: [] },
    internal: { selector: '#to-list', expected: { path: '/list', language: 'ko' }, ready: { selectors: ['#results[aria-busy=false]'] } },
    actions: [
      { id: 'artwork', name: 'Inspect and close fixture artwork', kind: 'overlay', selector: '#artwork', opened: '.artwork-focus-overlay[role=dialog]', interactive: '.artwork-focus-overlay:not(.is-opening)', close: '#close-artwork' },
      { id: 'share', name: 'Generate fixture share URL', kind: 'share', selector: '#share', expected: { path: '/preview', query: { meum_share: 'copy_link' } } },
      { id: 'enter', name: 'Click fixture entry', kind: 'entry', selector: '#enter', expected: { paths: ['/viewer', '/write-viewer'], query: { r: encodePublicRoomId(4348), meum_entry_room: encodePublicRoomId(4348), meum_entry: 'introduction' } }, arrival: { selectors: ['#viewer-ready'], errors: ['[role=alert]'], blockedRequestPaths: ['/customer-write'] } },
    ],
  });
  const runPreview = (fault = '', extra = {}) => runJourneys(browser, { url: `${origin}/preview${fault ? `?fault=${fault}` : ''}`, journeyContract: previewContract() }, { ...config(), ...extra });

  it('performs direct, SPA, reload, history, close, repeat, mobile, share and actual entry arrival', async () => {
    const result = await runPreview();
    assert.equal(result.status, 'pass', JSON.stringify(result.cases.filter(item => item.status !== 'pass')));
    for (const mode of ['direct', 'spa-internal', 'reload', 'history', 'cancel', 'repeat', 'mobile']) assert.ok(result.cases.some(item => item.mode === mode && item.status === 'pass'), mode);
    const arrival = result.cases.find(item => item.id === 'enter-arrival');
    assert.equal(arrival.status, 'pass');
    assert.equal(arrival.observed.destinationVisited, true);
    assert.equal(result.cases.find(item => item.id === 'enter').observed.destinationVisited, false);
    assert.equal(result.cases.find(item => item.id === 'share').observed.nativeShareSucceeded, false);
    assert.equal(result.cases.find(item => item.id === 'share-cancel').status, 'pass');
    assert.equal(receivedWrites, 0);
  });

  it('does not accept a missing close action or a generated entry URL without completed arrival', async () => {
    const missing = await runPreview('missing-close', { journeyModes: ['cancel'] });
    assert.equal(missing.status, 'blocked');
    assert.equal(missing.cases.find(item => item.id === 'cancel').status, 'blocked');
    const blocked = await runPreview('needs-write', { journeyModes: ['actions'] });
    assert.equal(blocked.status, 'blocked', JSON.stringify(blocked.cases));
    assert.equal(blocked.cases.find(item => item.id === 'enter').status, 'pass');
    assert.equal(blocked.cases.find(item => item.id === 'enter-arrival').status, 'blocked');
    assert.ok(blocked.cases.find(item => item.id === 'enter-arrival').blockedWriteRequests.length);
    assert.equal(receivedWrites, 0);
  });

  it('rejects a misrouted internal click, wrong share URL and wrong rendered language', async () => {
    assert.equal((await runPreview('wrong-destination', { journeyModes: ['spa-internal'] })).status, 'fail');
    const share = await runPreview('wrong-share', { journeyModes: ['actions'] });
    assert.equal(share.cases.find(item => item.id === 'share').status, 'fail');
    const arrivalsBeforeWrongRoom = viewerReads;
    const wrongRoom = await runPreview('wrong-room', { journeyModes: ['actions'] });
    assert.equal(wrongRoom.cases.find(item => item.id === 'enter').status, 'fail', 'the correct viewer path with another exhibition hash must fail');
    assert.equal(viewerReads, arrivalsBeforeWrongRoom, 'an invalid generated entry must not be visited');
    assert.equal((await runPreview('english', { journeyModes: ['direct'] })).status, 'fail');
    const pricing = contractFor({ url: 'https://meum.me/plan' }, { journeyLanguage: 'ko' });
    const forged = await runJourneys(browser, { url: `${origin}/plan?fault=forged-language`, journeyContract: { ...pricing, requireVueMounted: false, url: `${origin}/plan?fault=forged-language` } }, { ...config(), journeyModes: ['direct'] });
    assert.equal(forged.status, 'fail', 'a Korean html.lang must not hide English pricing content');
    assert.match(forged.cases.find(item => item.id === 'direct').reason, /labels/);
  });

  it('searches through actual submit clicks and restores, repeats and checks the mobile list', async () => {
    const target = { url: `${origin}/list`, journeyContract: {
      id: 'fixture-list', language: 'ko', expected: { path: '/list', language: 'ko' }, ready: { selectors: ['#search', '#results[aria-busy=false]'] },
      internal: { from: `${origin}/home`, selector: '#to-list', expected: { path: '/list', language: 'ko' } },
      actions: [{ id: 'search', name: 'Search fixture list', kind: 'search', selector: '#search', submit: '#search-submit', queryKey: 'query', term: 'MEUM', ready: '#results[aria-busy=false]', request: { path: '/room/list', queryKey: 'query' }, results: { cards: '#results .result-card', title: '.result-title', open: '.result-open', empty: '#results .none-item[role=status]', destinationTitle: '#result-heading' } }],
    } };
    const result = await runJourneys(browser, target, config());
    assert.equal(result.status, 'pass', JSON.stringify(result.cases.filter(item => item.status !== 'pass')));
    assert.ok(result.cases.find(item => item.id === 'search').checks.some(check => check.name === 'search-and-restore' && check.passed));
    const stale = await runJourneys(browser, { ...target, url: `${origin}/list?fault=stale-search` }, { ...config(), journeyModes: ['actions'] });
    assert.equal(stale.status, 'fail', 'changing the URL without fetching new results must not pass');
    for (const fault of ['stale-card', 'wrong-card', 'empty-wrong']) {
      const invalid = await runJourneys(browser, { ...target, url: `${origin}/list?fault=${fault}` }, { ...config(), journeyModes: ['actions'] });
      assert.equal(invalid.status, 'fail', `${fault} must not pass response-to-rendered-result checks`);
    }
    const empty = await runJourneys(browser, { ...target, url: `${origin}/list?fault=empty-correct` }, { ...config(), journeyModes: ['actions'] });
    assert.equal(empty.cases.find(item => item.id === 'search').status, 'pass', JSON.stringify(empty.cases));
    assert.equal(empty.cases.find(item => item.id === 'search-known-positive').status, 'blocked');
    assert.equal(empty.status, 'blocked');
    assert.equal(empty.partialScope, true);
    const alwaysEmpty = await runJourneys(browser, { ...target, url: `${origin}/list?fault=always-empty-search` }, { ...config(), journeyModes: ['actions'] });
    assert.equal(alwaysEmpty.cases.find(item => item.id === 'search').status, 'pass', 'an empty MEUM result alone is a valid empty-state observation');
    assert.equal(alwaysEmpty.cases.find(item => item.id === 'search-known-positive').status, 'fail', 'always-empty backend must fail for a known existing title');
  });

  it('reports unsupported functions as unregistered instead of passing an inert page', async () => {
    const result = await runJourneys(browser, { url: `${origin}/unregistered` }, config());
    assert.equal(result.status, 'unregistered');
    assert.equal(result.cases.length, 0);
    const subset = await runPreview('', { journeyModes: ['direct'] });
    assert.equal(subset.cases.find(item => item.id === 'direct').status, 'pass');
    assert.equal(subset.status, 'not-run');
    assert.ok(subset.cases.some(item => item.mode === 'history' && item.required && item.status === 'not-run'));
    const declared = previewContract();
    declared.modes = ['direct'];
    const scoped = await runJourneys(browser, { url: `${origin}/preview`, journeyContract: declared }, config());
    assert.equal(scoped.status, 'pass');
    assert.equal(scoped.partialScope, false);
    const mounted = { ...previewContract(), requireVueMounted: true, modes: ['direct'] };
    const noRuntime = await runJourneys(browser, { url: `${origin}/preview?fault=telemetry-only`, journeyContract: mounted }, config());
    assert.equal(noRuntime.status, 'fail', 'blocked analytics must not hide missing runtime mount behind policy-blocked status');
    const hydrated = await runJourneys(browser, { url: `${origin}/preview?fault=hydrate-later`, journeyContract: mounted }, config());
    assert.equal(hydrated.status, 'pass');
    assert.equal(hydrated.cases[0].observed.vueMounted, true);
  });
});

test('journey instrumentation blocks known mutating reads before the fixture receives them', { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 15000 }, async () => {
  const endpoints = ['/api/rooms/123/roses', '/api/rooms/comment-settings/123', '/api/rooms/123/password/status'];
  let receivedMutations = 0;
  const server = createServer((request, response) => {
    if (endpoints.includes(request.url) || request.url === '/write') receivedMutations++;
    response.setHeader('Content-Type', 'text/html');
    response.end(`<html lang="ko"><body><main><h1>Readonly fixture</h1></main><script>for(const path of ${JSON.stringify(endpoints)}) for(const method of ['GET','HEAD']) fetch(path,{method}).catch(()=>{});fetch('/write',{method:'POST'}).catch(()=>{});</script></body></html>`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { launchBrowser } = await import('../probe.mjs');
  let browser;
  try {
    browser = await launchBrowser();
    const result = await runJourneys(browser, { url: `${origin}/fixture`, journeyContract: {
      id: 'mutating-read-fixture', modes: ['direct'], role: 'guest', language: 'ko', expected: { path: '/fixture', language: 'ko' },
      ready: { selectors: ['#mutation-result'], blockedRequestPaths: endpoints }, actions: [],
    } }, { origins: [origin], journeyTimeoutMs: 500, navigationTimeoutMs: 3000 });
    assert.equal(receivedMutations, 0);
    assert.equal(result.status, 'blocked');
    assert.equal(result.cases[0].blockedWriteRequests.filter(request => request.kind === 'mutating-read').length, 6);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
