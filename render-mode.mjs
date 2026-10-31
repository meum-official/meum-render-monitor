import { createHash } from 'node:crypto';
import { ruleFor } from './contracts.mjs';
import { readPolicyDecision } from './read-only-policy.mjs';

export const excluded = () => ({ required: false, status: 'not-run', cases: [], reason: '대상 아님: 화면 렌더링만 검사합니다.' });
const revision = value => /^[a-f0-9]{40}$/.test(value || '') ? value : 'unknown';
export function versionEvidence(source = {}) {
  const sourceRevision = revision(source.sourceRevision), deployedRevision = revision(source.deployedRevision);
  return { monitorRevision: revision(source.monitorRevision), sourceRevision, deployedRevision,
    contractHash: /^[a-f0-9]{64}$/.test(source.contractHash || '') ? source.contractHash : 'unknown',
    comparison: sourceRevision === 'unknown' || deployedRevision === 'unknown' ? 'unknown' : sourceRevision === deployedRevision ? 'match' : 'mismatch' };
}
export const contractDigest = bytes => createHash('sha256').update(bytes).digest('hex');
export function renderingConfig(config) {
  if (config.renderOnly !== true) return config;
  return { ...config, business: undefined, publicObservationPolicy: undefined, observePage: undefined,
    functionalNavigation: false, followViewerEntries: false, homeSpecificationEnabled: false,
    pageSpecificationEnabled: false, retailSpecificationEnabled: false };
}
export function renderLayers(result) {
  return { ...result, renderOnly: true, layers: {
    render: { required: true, status: ['pass', 'fail'].includes(result.status) ? result.status : 'not-run', checkedAt: result.checkedAt, checks: result.checks || [], evidenceScope: 'public-readonly' },
    navigation: excluded(), business: excluded(),
  } };
}
export function renderSummary(results) {
  const render = { pass: 0, fail: 0, blocked: 0, unregistered: 0, 'not-run': 0, total: results.length };
  for (const row of results) render[['pass', 'fail'].includes(row.status) ? row.status : 'not-run']++;
  render.status = render.fail ? 'fail' : render['not-run'] ? 'not-run' : render.total ? 'pass' : 'not-run';
  return { render, navigation: { ...excluded(), total: 0, excluded: results.length }, business: { ...excluded(), total: 0, excluded: 11 }, status: render.status };
}

const publicReads = new Set(['/room/list', '/room/tags', '/boards/list/check-new', '/boards/board-list', '/boards/popup-list', '/surveys/home/active', '/faqs', '/api/billing/plan/catalog', '/api/webtoon/episodes', '/exhibitions/exhibition-list', '/api/users/simple_profile']);
// Audited SELECT/COUNT and S3 ListObjectsV2 callers; see RENDER_READ_REVIEW.md.
// This is page-specific permission, not a wildcard for archive/workspace APIs.
export function reviewedPublicRenderRead(request, targetUrl) {
  let url, target;
  try { url = new URL(request.url()); target = new URL(targetUrl); } catch { return false; }
  if (request.method() !== 'GET' || url.origin !== 'https://backend.meum.me' || url.hash || url.username || url.password
    || !['fetch', 'xhr'].includes(request.resourceType()) || target.username || target.password || target.hash
    || Object.keys(request.headers()).some(name => ['authorization', 'proxy-authorization', 'cookie'].includes(name.toLowerCase()))) return false;
  const exact = values => url.searchParams.size === Object.keys(values).length && Object.entries(values).every(([key, value]) => url.searchParams.get(key) === value);
  if (['https://meum.me', 'https://www.meum.me'].includes(target.origin) && !target.search
    && /^\/creator\/ws_[A-Za-z0-9_-]{1,128}$/.test(target.pathname)) {
    return url.pathname === `/api/workspaces${target.pathname}` && !url.search;
  }
  if (target.origin !== 'https://archive.meum.me') return false;
  if (['/', '/archive'].includes(target.pathname) && (target.searchParams.size === 0 || target.searchParams.size === 1 && /^[1-9]\d{0,8}$/.test(target.searchParams.get('page') || ''))) {
    const offset = String((Number(target.searchParams.get('page') || 1) - 1) * 50);
    return url.pathname === '/api/archive/owners' && exact({ activeOnly: '0', limit: '50', offset });
  }
  const owner = target.searchParams.get('i');
  if (/^\/archive\/[^/]+$/.test(target.pathname) && target.searchParams.size === 1 && /^[1-9]\d{0,9}$/.test(owner || '')) {
    return url.pathname === `/api/archive/owners/${owner}` && !url.search
      || url.pathname === '/api/archive/rooms' && exact({ ownerId: owner, limit: '50', offset: '0' });
  }
  return false;
}

export function renderReadAllowed(request, origins, targetUrl) {
  const url = new URL(request.url());
  if (!['GET', 'HEAD'].includes(request.method()) || readPolicyDecision(url.href).blocked) return false;
  if (Object.keys(request.headers()).some(name => ['authorization', 'proxy-authorization'].includes(name.toLowerCase()))) return false;
  if (request.isNavigationRequest?.() && request.resourceType() === 'document' && !origins.includes(url.origin)) return false;
  if (url.hostname.replace(/\.$/, '') !== 'backend.meum.me') return true;
  if (url.origin !== 'https://backend.meum.me') return false;
  return reviewedPublicRenderRead(request, targetUrl) || publicReads.has(url.pathname) || /^\/room\/[1-9]\d*$/.test(url.pathname)
    || /^\/user\/room\/detail\/?$/.test(url.pathname)
    || /^\/api\/rooms\/[1-9]\d*\/(viewer-entry|public-invitation-settings)$/.test(url.pathname)
    || /^\/exhibition\/invitation\/[A-Za-z0-9_-]+\/introduction$/.test(url.pathname)
    || /^\/api\/archive\/rooms\/[1-9]\d*$/.test(url.pathname)
    || /^\/api\/webtoon\/assets\/[A-Za-z0-9_-]+\/content$/.test(url.pathname)
    || /^\/api\/webtoon\/episodes\/[1-9]\d*\/likes$/.test(url.pathname)
    || /^\/item\/[1-9]\d*\/catalog$/.test(url.pathname);
}

// Stable content IDs survive changes to decorative wrappers and CSS class names.
const semantic = {
  '/home': ['[data-page="home"] h1, .school-home h1', '[data-page="home"] [data-render="content"], .school-home #cases'],
  '/school/teacher-guide': ['#teacher-guide-title', '#teacher-video-title'],
  '/meum-service': ['#service-title', '[data-page="service"] [data-render="content"], .service-page .service-primary'],
  '/webtoon': ['#webtoon-title', '#webtoon-episodes-title'],
  '/exhibition': ['[data-page="exhibition-list"], .exh-page', '[data-render="results"][aria-busy="false"], .exh-browse__results[aria-busy=false]'],
};
export function renderRuleFor(url) {
  const rule = ruleFor(url), parsed = new URL(url);
  if (!['meum.me', 'www.meum.me'].includes(parsed.hostname)) return rule;
  const selectors = semantic[parsed.pathname] || rule.selectors;
  if (/^\/customer-center\/(notice|event|qna)$/.test(parsed.pathname)) {
    return { ...rule, selectors: [rule.selectors[0], '.customer-center__view .board .table-board .board-item, .customer-center__view [data-render-state="empty"][role="status"]'] };
  }
  return { ...rule, selectors };
}

export function applyVersionEvidence(result, evidence) {
  result.versions = versionEvidence(evidence);
  if (result.versions.comparison === 'mismatch') {
    result.issues.push({ kind: 'baseline-version', message: '기준 소스와 배포 버전이 달라 화면 명세 비교가 미확인입니다.' });
    const independentFailure = result.issues.some(x => ['http', 'http-resource', 'javascript', 'browser-crash', 'network', 'broken-image', 'broken-background'].includes(x.kind));
    if (!independentFailure) result.status = 'unknown';
  }
  return result;
}

export async function observeLayout(page, expectedWidth) {
  return page.evaluate(width => ({ viewport: width, layoutViewport: innerWidth, width: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > width + 2 }), expectedWidth);
}

export async function observeLazyImages(page) {
  const broken = new Set(); let pending = 0;
  for (let index = 0; index < 3; index++) {
    await page.evaluate(step => scrollTo(0, step * innerHeight), index);
    await page.waitForTimeout(150);
    const observed = await page.evaluate(async () => {
      const visible = image => { const r = image.getBoundingClientRect(), s = getComputedStyle(image); return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0; };
      const images = [...document.images].filter(visible);
      await Promise.race([Promise.all(images.map(image => image.complete ? null : new Promise(resolve => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); }))), new Promise(resolve => setTimeout(resolve, 1000))]);
      return { broken: images.filter(image => image.complete && !image.naturalWidth).map(image => image.currentSrc || image.src), pending: images.filter(image => !image.complete).length };
    });
    observed.broken.forEach(url => broken.add(url)); pending += observed.pending;
  }
  await page.evaluate(() => scrollTo(0, 0));
  return { broken: [...broken], pending, viewports: 3 };
}
