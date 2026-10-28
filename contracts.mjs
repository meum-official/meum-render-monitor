// These selectors belong to page content, so a shared header cannot prove a route rendered.
const content = (selectors, extra = {}) => ({ selectors, loading: [], errors: [], ...extra });
const unsupported = () => content([], { unsupported: true });
const normalizePath = pathname => pathname.replace(/\/+$/, '') || '/';

const staticPages = {
  '/': ['.school-home .school-hero h1'],
  '/home': ['.school-home .school-hero h1'],
  '/en': ['.school-home .school-hero h1'],
  '/home2': ['.home2 .home2-hero h1', '.home2-showcase'],
  '/ai-art-exhibition': ['.ai-art-page #ai-art-title', '.ai-art-page .hero-copy .ai-button'],
  '/en/guides': ['.service-manual .manual-header h1', '.manual-content .manual-section'],
  '/tools/exhibition-poster': ['.poster-tool #tool-title', '.poster-tool .poster-form'],
  '/meum-service': ['.service-page #service-title', '.service-page .service-primary'],
  '/plan': ['.plan-select .pricing-hero__title', '.plan-select #group-plans-title'],
  '/cases': ['.usecase-page .hero__title', '.usecase-page .case-card'],
  '/sample-exhibition': ['.sample-page .sample-intro h1', '.sample-page #sample-request'],
  '/school/teachers': ['.teacher-landing #teacher-title', '.teacher-landing .sample-cta'],
  '/school/teacher-guide': ['.teacher-guide-page #teacher-guide-title', '.teacher-guide-page #teacher-video-title'],
  '/galleries': ['.gs-wrap .gs-hero__title', '.gs-wrap .gs-card-grid .gs-card'],
  '/customer-center/notice': ['.customer-center .hero__title', '.customer-center__view .board .first-board'],
  '/customer-center/event': ['.customer-center .hero__title', '.customer-center__view .board .first-board'],
  '/customer-center/qna': ['.customer-center .hero__title', '.customer-center__view .board .first-board'],
  '/customer-center/contact': ['.customer-center__view .contact', '.contact .operating-hours, .contact .school-inquiry'],
  '/customer-center/certificated': ['.certificated .certificated-top h2', '#certificate-serial-1'],
  '/en/get-started': ['.get-started h1', '.get-started ol'],
  '/en/team': ['.english-team h1'],
  '/webtoon': ['.webtoon-page #webtoon-title', '.webtoon-page #webtoon-episodes-title'],
  '/login': ['.login__info-form input[type=email]', '.login__info-form input[type=password]'],
  '/login/info': ['.login__info-form input[type=email]', '.login__info-form input[type=password]'],
  '/login/findPassword': ['.find-password h1', '.find-password input[type=email]'],
  '/login/findEmail': ['.find-email h1', '.find-email input#nickname'],
  '/register': ['.register-content .register-age-gate h1', '.register-age-gate__checkbox'],
};

const preview = () => content(['.preview2 .hero__content h1', '.preview2 .hero__actions .button--hero'], {
  loading: ['.preview2__loading'],
  errors: ['.preview2__error'],
  unknownSelectors: ['.exhibition-password-dialog'],
});

const viewer = () => content(['.meum-lite-viewer-container canvas#unity-canvas'], {
  canvas: true,
  requiredGlobal: 'unityInstance',
  loading: ['.meum-lite-viewer-container .loading-overlay', '.meum-lite-viewer-container #loading-overlay', '.viewer-entry[aria-busy=true]'],
  errors: ['.meum-lite-viewer-container .viewer-state-overlay[role=alert]'],
  // An ended, login, or password gate is not evidence that the requested 3D scene loaded.
  unknownSelectors: ['.viewer-entry[aria-busy=false]', '.exhibition-password-dialog'],
});

export function ruleFor(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return unsupported(); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return unsupported();
  const path = normalizePath(parsed.pathname);

  if (parsed.hostname === 'archive.meum.me') {
    if (path === '/' || path === '/archive') return content(['.archive-home h1', '#archive-owner-list-title', '.archive-home__toolbar [role=status]'], {
      errors: ['.archive-home [role=alert]'],
    });
    if (/^\/archive\/viewer\/\d+$/.test(path) || /^\/archive\/[^/]+\/\d+$/.test(path)) return content([
      '.archive-viewer-page__summary h1', '.archive-unity-viewer__canvas-wrap.is-ready canvas#unity-canvas',
    ], {
      canvas: true,
      requiredGlobal: 'unityInstance',
      loading: ['.archive-unity-viewer__loading'],
      errors: ['.archive-viewer-page__state.is-error', '.archive-unity-viewer__error'],
      unknownSelectors: ['.exhibition-password-dialog'],
    });
    if (/^\/archive\/[^/]+$/.test(path)) return content([
      '.archive-owner-page .archive-header__title', '.archive-owner-page__index #archive-record-index-heading',
    ], {
      loading: ['.archive-owner-page__state[role=status]'],
      errors: ['.archive-owner-page__state[role=alert]'],
    });
    return unsupported();
  }

  if (parsed.hostname !== 'meum.me' && parsed.hostname !== 'www.meum.me') return unsupported();
  if (path === '/meum-lite-viewer' || /^\/oneday\/[^/]+\/viewer$/.test(path)) return viewer();
  if (/^\/exhibition\/(?:preview\/)?\d+$/.test(path) || /^\/oneday\/[^/]+$/.test(path)) return preview();
  if (/^\/exhibition\/invitation\/[^/]+$/.test(path) || /^\/sample-exhibition\/[^/]+\/invitation$/.test(path)) return content([
    '.invitation-mobile .invitation h1',
  ], { loading: ['.invitation-intro-overlay', '.invitation-mobile__state'], unknownSelectors: ['.exhibition-password-dialog'] });
  if (path === '/exhibition') return content(['.exh-page', '.exh-browse__results[aria-busy=false]'], {
    loading: ['.exh-browse__loading', '.exh-browse__results[aria-busy=true]'],
  });
  if (/^\/creator\/ws_[a-zA-Z0-9_-]+$/.test(path)) return content([
    '.creator-archive__owner-copy h1', '.creator-archive__main .creator-archive__section',
  ], { loading: ['.creator-archive__loading'] });
  if (path === '/en/pricing') return content(['.international-pricing header h1', '.international-pricing .audience'], {
    loading: ['.international-pricing > p[role=status]'], errors: ['.international-pricing > p[role=alert]'],
  });
  if (/^\/webtoon\/[^/]+$/.test(path)) return content(['.webtoon-reader #reader-title', '.reader-images .reader-image img'], {
    errors: ['.reader-image__error'],
  });
  return staticPages[path] ? content([...staticPages[path]]) : unsupported();
}

export function allowedNavigation(from, to) {
  try {
    const source = new URL(from);
    const destination = new URL(to, source);
    if (!['https:', 'http:'].includes(source.protocol) || source.origin !== destination.origin || source.username || source.password || destination.username || destination.password) return false;
    const before = normalizePath(source.pathname);
    const after = normalizePath(destination.pathname);
    if (before === after) return true;
    if (before === '/' && after === '/home') return true;
    if (before === '/login' && after === '/login/info') return true;
    const legacy = before.match(/^\/exhibition\/(\d+)$/);
    return !!legacy && after === `/exhibition/preview/${legacy[1]}`;
  } catch { return false; }
}
