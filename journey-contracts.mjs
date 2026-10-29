import Hashids from 'hashids';

const pathOf = value => new URL(value).pathname.replace(/\/+$/, '') || '/';
const languageOf = value => String(value || '').toLowerCase().split(/[-_]/)[0];
// This is the existing published URL contract in 8301 src/utils/shortId.js.
const roomIds = new Hashids('Eunseo', 6);
export const encodePublicRoomId = id => Number.isSafeInteger(Number(id)) && Number(id) > 0 ? roomIds.encode(Number(id)) : null;
export const JOURNEY_MODES = ['direct', 'spa-internal', 'reload', 'history', 'cancel', 'repeat', 'mobile', 'actions'];

export function evaluateDestination(expected, observed, { sourceUrl } = {}) {
  try {
    if (expected.variants) {
      const outcomes = expected.variants.map(variant => evaluateDestination({ ...variant, ...(expected.language ? { language: expected.language } : {}) }, observed, { sourceUrl }));
      const passed = outcomes.some(outcome => outcome.passed);
      const specific = outcomes.find(outcome => /query|language/.test(outcome.reason));
      return { passed, reason: passed ? 'Destination matches the source exhibition identity' : specific?.reason || 'Destination does not match the source exhibition identity' };
    }
    const actual = new URL(typeof observed === 'string' ? observed : observed.url);
    const base = new URL(sourceUrl || expected.url || actual.href);
    if (!['http:', 'https:'].includes(actual.protocol) || actual.username || actual.password) return { passed: false, reason: 'Unsafe destination URL' };
    const origins = expected.origins || [base.origin];
    if (!origins.includes(actual.origin)) return { passed: false, reason: 'Destination origin does not match the contract' };
    const actualPath = pathOf(actual.href);
    const expectedPaths = expected.paths || (expected.path ? [expected.path] : expected.url ? [pathOf(expected.url)] : []);
    if (expectedPaths.length && !expectedPaths.map(value => value.replace(/\/+$/, '') || '/').includes(actualPath)) return { passed: false, reason: 'Destination path does not match the intended page' };
    if (expected.pathPattern && !new RegExp(expected.pathPattern).test(actualPath)) return { passed: false, reason: 'Destination path does not match the registered route' };
    for (const [key, value] of Object.entries(expected.query || {})) {
      if (value === null ? actual.searchParams.has(key) : actual.searchParams.get(key) !== String(value)) return { passed: false, reason: `Destination query ${key} does not match` };
    }
    if (expected.language) {
      const language = languageOf(observed.language);
      if (!language || language !== languageOf(expected.language)) return { passed: false, reason: 'Rendered language does not match user intent' };
      if (languageOf(expected.language) === 'ko' && actualPath.startsWith('/en/')) return { passed: false, reason: 'Korean intent was redirected to an English page' };
    }
    return { passed: true, reason: 'Clicked destination and rendered language match the contract' };
  } catch { return { passed: false, reason: 'Invalid destination evidence' }; }
}

export function contractFor(target, config = {}) {
  let url;
  try { url = new URL(target.url); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const override = target.journeyContract || config.journeyContracts?.[url.pathname];
  // Fixture contracts may not introduce arbitrary actions on a production service.
  if (override) {
    try { if (!local || new URL(override.url || url.href).origin !== url.origin) return null; } catch { return null; }
    return { role: 'guest', language: 'ko', url: url.href, ...structuredClone(override) };
  }
  if (url.origin !== 'https://meum.me') return null;
  const path = pathOf(url.href);
  const language = languageOf(target.expectedLanguage || (path === '/en' || path.startsWith('/en/') ? 'en' : '') || url.searchParams.get('locale') || config.journeyLanguage || 'ko');
  const origin = url.origin;
  const base = { role: 'guest', language, url: url.href, requireVueMounted: true, prerequisites: ['Fresh unauthenticated browser context', 'No customer write requests', 'The production Vue app has mounted before interactions', `Declared language intent ${language}: set only the isolated guest browser language preference`], evidenceScope: 'public-instrumented' };
  const pricingPath = language === 'en' ? '/en/pricing' : '/plan';
  if (path === '/plan' || path === '/en/pricing') return {
    ...base, id: 'public-pricing', page: 'pricing',
    expected: { path: pricingPath, language },
    ready: { selectors: language === 'en' ? ['.international-pricing > header h1', '.international-pricing .plan-grid > article'] : ['.plan-select .pricing-hero__title', '.plan-select #group-plans-title'], loading: ['.international-pricing > p[role=status]'], errors: ['.international-pricing > p[role=alert]'], textChecks: language === 'en' ? [{ selector: '.international-pricing > header h1', includes: 'Your art. Your own exhibition.' }] : [{ selector: '.plan-select .pricing-hero__title', includes: '우리 학교 미술전' }, { selector: '.plan-select #group-plans-title', includes: '어떤 전시를 준비하고 계신가요' }] },
    internal: { from: `${origin}${language === 'en' ? '/en' : '/home'}`, selector: `.header a[href="${pricingPath}"], .mobile-menu__links a[href="${pricingPath}"]`, reveal: '.hamburger-icon', expected: { path: pricingPath, language } },
    actions: [],
  };
  if (path === '/exhibition') return {
    ...base, id: 'public-exhibition-list', page: 'exhibition-list', expected: { path, language },
    ready: { selectors: ['.exh-browse__results[aria-busy=false]', '#exhibition-search'], loading: ['.exh-browse__loading'], errors: [] },
    internal: { from: `${origin}${language === 'en' ? '/en' : '/home'}`, selector: '.header a[href="/exhibition"], .mobile-menu__links a[href="/exhibition"]', reveal: '.hamburger-icon', expected: { path, language } },
    actions: [{ id: 'search', name: 'Search public exhibitions and restore the unfiltered list', kind: 'search', selector: '#exhibition-search', submit: '.exh-browse__search-submit', queryKey: 'query', term: config.journeySearchTerm || 'MEUM', ready: '.exh-browse__results[aria-busy=false]', request: { origin: 'https://backend.meum.me', path: '/room/list', queryKey: 'query' }, results: { cards: '.exh-browse__grid .exh-card', title: '.exh-card__title', open: '.exh-card__body', empty: '.exh-browse__results .none-item[role=status]', destinationTitle: '.preview2 .hero__content h1' } }],
  };
  const regular = path.match(/^\/exhibition\/(?:preview\/)?(\d+)$/);
  const oneday = path.match(/^\/oneday\/([a-zA-Z0-9_-]+)$/);
  if (regular || oneday) {
    const canonical = regular ? `/exhibition/preview/${regular[1]}` : path;
    return {
      ...base, id: 'public-exhibition-preview', page: 'exhibition-preview', expected: { path: canonical, language },
      ready: { selectors: ['.preview2 .hero__content h1', '.preview2 .hero__actions .button--hero'], loading: ['.preview2__loading'], errors: ['.preview2__error'], gates: ['.exhibition-password-dialog'] },
      internal: { selector: '.hero__back', expected: { path: oneday ? '/home' : '/exhibition', language }, ready: { selectors: oneday ? ['.school-home .school-hero h1'] : ['.exh-browse__results[aria-busy=false]'], loading: ['.exh-browse__loading'], errors: [] } },
      actions: [
        { id: 'artwork', name: 'Open an artwork, close it and open it again', kind: 'overlay', selector: '.preview2 .artworks .artwork', opened: '.artwork-focus-overlay[role=dialog]', interactive: '.artwork-focus-overlay:not(.is-opening):not(.is-closing)', close: '.artwork-focus-overlay .focus-close-button' },
        { id: 'share', name: 'Generate the public exhibition share URL', kind: 'share', selector: '.hero-education__share, .hero__actions .button--outline', expected: { path: canonical, query: { meum_share: 'copy_link', meum_entry: null, meum_entry_room: null } } },
        { id: 'enter', name: 'Enter the exhibition using the actual entry button', kind: 'entry', selector: '.hero__actions .button--hero', expected: oneday ? { path: `${path}/viewer`, origins: [origin] } : { variants: [{ path: '/meum-lite-viewer', origins: [origin], query: { r: encodePublicRoomId(regular[1]), meum_entry_room: encodePublicRoomId(regular[1]), meum_entry: 'introduction' } }, { path: `/archive/viewer/${regular[1]}`, origins: ['https://archive.meum.me'], query: { meum_entry: 'introduction' } }] }, arrival: { requireVueMounted: false, selectors: ['.meum-lite-viewer-container canvas#unity-canvas, .archive-unity-viewer__canvas-wrap.is-ready canvas#unity-canvas'], loading: ['.loading-overlay', '#loading-overlay', '.archive-unity-viewer__loading'], errors: ['.viewer-state-overlay[role=alert]', '.archive-unity-viewer__error'], gates: ['.viewer-entry', '.exhibition-password-dialog'], requiredGlobal: 'unityInstance', blockedRequestPaths: ['/api/rooms/roomById'] } },
      ],
    };
  }
  return null;
}
