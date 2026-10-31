// Roles describe current checked-in callers, not attestation of deployed artifacts.
// Every returned contract/sourceEvidence is a fixed enum; no URL, ID or query is returned.
const appOrigins = new Set(['https://meum.me', 'https://www.meum.me', 'https://archive.meum.me', 'https://board.meum.me']);
const local = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
const result = (role = 'unknown', contract = 'unclassified') => ({ role, contract, sourceEvidence: contract });
const likesFallbackStatuses = new Set([401, 419, 403, 404, 501, 503]);

export function resourceRole({ url, method = 'GET', resourceType, targetUrl, status = null }) {
  let request, target;
  try {
    request = new URL(url); target = new URL(targetUrl);
    if (![request, target].every(value => ['http:', 'https:'].includes(value.protocol) && !value.username && !value.password)) return result();
  } catch { return result(); }
  if (!appOrigins.has(target.origin) && !local(target)) return result();
  const verb = String(method).toUpperCase();
  const read = verb === 'GET' || verb === 'HEAD';
  const path = request.pathname.replace(/\/+$/, '') || '/';
  const page = target.pathname.replace(/\/+$/, '') || '/';
  const main = ['https://meum.me', 'https://www.meum.me'].includes(target.origin) || local(target);
  const archiveTarget = target.hostname === 'archive.meum.me' && (/^\/archive\/viewer\/\d+$/.test(page) || /^\/archive\/[^/]+\/\d+$/.test(page));
  const normalViewer = main && page === '/meum-lite-viewer';
  const preview = main && /^\/exhibition\/(?:preview\/)?\d+$/.test(page);
  const invitation = main && /^\/exhibition\/invitation\/[^/]+$/.test(page);
  const webtoon = main && /^\/webtoon(?:\/[^/]+)?$/.test(page);
  const backend = request.origin === 'https://backend.meum.me' || local(target) && request.origin === target.origin;

  // session.js324-340 catches beacon/fetch failures. The three GA collector
  // origins and /g/collect matched stored request hashes; no other Google routes qualify.
  if (verb === 'POST' && ['fetch', 'xhr', 'other', 'ping'].includes(resourceType) && (
    backend && path === '/analytics/ingest' ||
    ['https://www.google.com', 'https://analytics.google.com', 'https://stats.g.doubleclick.net'].includes(request.origin) && path === '/g/collect'
  )) return result('optional', 'telemetry');
  // analytics/index.js setup is best-effort; telemetry does not initialize page content.
  if (/(^|\.)(?:google-analytics\.com|googletagmanager\.com)$/.test(request.hostname)) return result('optional', 'telemetry');
  // The GA audience pixel is analytics; it does not supply page content.
  if (read && resourceType === 'image' && request.origin === 'https://www.google.co.kr' && path === '/ads/ga-audiences') return result('optional', 'telemetry');
  // Browser-declared application resources on this page's own origin. Third-party
  // scripts/frames are not promoted to essential merely because they are scripts.
  if (read && request.origin === target.origin) {
    if (resourceType === 'document') return result('essential', 'document');
    if (resourceType === 'script') return result('essential', 'application-script');
    if (resourceType === 'stylesheet') return result('essential', 'stylesheet');
  }
  if (!backend || !['fetch', 'xhr'].includes(resourceType)) return result();

  // ExhibitionCreatorArchive.vue awaits this public route; routes/workspaces.js
  // registers it before jwt.auth. No personal-workspace provisioning is called.
  if (read && main && /^\/creator\/ws_[A-Za-z0-9_-]+$/.test(page) && path === `/api/workspaces${page}`) return result('essential', 'creator-public-data');

  // archive pages/index.vue bootstrap awaits utils/archiveApi.js
  // fetchArchiveOwnersPage (GET /api/archive/owners). A denied dependency
  // prevents both the result status and list; this role grants no permission.
  if (read && path === '/api/archive/owners' && target.hostname === 'archive.meum.me' && ['/', '/archive'].includes(page)) return result('essential', 'archive-owners');
  // archive pages/archive/[nickname].vue awaits findArchiveOwner before rooms.
  // Both the exact-ID lookup and nickname fallback are required prerequisites.
  if (read && target.hostname === 'archive.meum.me' && /^\/archive\/[^/]+$/.test(page) && (path === '/api/archive/owners' || /^\/api\/archive\/owners\/[1-9]\d*$/.test(path))) return result('essential', 'archive-owners');
  // fetchArchiveRoomsPage is then awaited to populate the owner's index.
  if (read && path === '/api/archive/rooms' && target.hostname === 'archive.meum.me' && /^\/archive\/[^/]+$/.test(page)) return result('essential', 'archive-room');

  // MeumLiteViewerEntry.vue419-447: exact-ID lifecycle preflight enables Unity.
  if (read && /^\/api\/rooms\/[1-9]\d*\/viewer-entry$/.test(path) && normalViewer) return result('essential', 'viewer-entry-preflight');
  // useExhibitionPassword.js16-42; MeumLiteViewer.vue6011; Entry.vue419-437.
  // This classifies a required prerequisite; it does NOT permit its mutating GET.
  if (read && /^\/api\/rooms\/[1-9]\d*\/password\/status$/.test(path) && (normalViewer || preview || invitation || archiveTarget)) return result('essential', 'viewer-password-bootstrap');
  // useExhibitionApi.js11-48 and MeumLiteViewer.vue6038. Actual method is POST:
  // backend .api/rooms/rooms.js1411/1420 migrates scenes and increments visits.
  if (verb === 'POST' && path === '/api/rooms/roomById' && normalViewer) return result('essential', 'viewer-room-bootstrap');
  // useExhibitionApi.js463-487: both requests form the artwork Promise.all.
  if (read && path === '/api/rooms/getDataJson' && normalViewer) return result('essential', 'viewer-scene-data');
  if (read && path === '/item/userItem-list' && normalViewer) return result('essential', 'viewer-items');
  // useExhibitionApi.js57-66 catches to null; viewer applies comment defaults.
  if (read && /^\/api\/rooms\/comment-settings\/[1-9]\d*$/.test(path) && normalViewer) return result('optional', 'viewer-comments');
  // Preview info is required there, but viewer.vue6046-6064 catches SEO failure.
  if (read && path === '/user/room/detail') {
    if (normalViewer) return result('optional', 'viewer-seo');
    if (preview || invitation) return result('essential', 'preview-detail');
  }
  // useExhibitionPreviewInfo.js284-294 invitation-only fallback.
  if (read && /^\/exhibition\/invitation\/[^/]+\/introduction$/.test(path) && invitation) return result('essential', 'invitation-intro');
  // archive utils/archiveApi.js153-175; room API is the viewer's required source.
  if (read && /^\/api\/archive\/rooms\/[1-9]\d*$/.test(path) && archiveTarget) return result('essential', 'archive-room');

  // useWebtoonCatalog.js10-43 only calls this when runtime CMS is enabled;
  // observing this exact request on a webtoon route is the runtime branch proof.
  if (read && path === '/api/webtoon/episodes' && webtoon) return result('essential', 'webtoon-catalog');
  // webtoonLikesApi.mjs12-20 and useWebtoonLikes.js40-89 define these fallbacks.
  // Other bad statuses stay unknown; a 500 is not a proven expected guest outcome.
  if (read && /^\/api\/webtoon\/episodes\/[1-9]\d{0,9}\/likes$/.test(path) && webtoon) {
    return result(status == null || status < 400 || likesFallbackStatuses.has(status) ? 'optional' : 'unknown', 'webtoon-likes');
  }
  // Main.js23-47,61 and store/userInfo.js199-212: session restore only with
  // saved authentication. Fresh guest rendering must not depend on this POST.
  if (verb === 'POST' && path === '/nodeApi/user') return result('optional', 'optional-session');
  // TheHeader.vue383-409: logged-in+uid watcher; failure clears badge only.
  if (read && path === '/api/users/my_plan') return result('optional', 'optional-plan');
  // main.js108 dispatches without awaiting; store/board.js25-35 updates badges.
  if (read && path === '/boards/list/check-new') return result('optional', 'optional-navigation-badge');
  // Preview2.vue929-941 and InvitationMobile.vue1656+: catch to null.
  if (read && path === '/api/users/simple_profile' && (preview || invitation)) return result('optional', 'optional-owner-profile');
  // InternationalPricing.vue170-203; billing.js239-242 is public configuration.
  if (read && path === '/api/billing/plan/catalog' && main && ['/plan', '/en/pricing'].includes(page)) return result('essential', 'pricing-catalog');
  // LoginInfo.vue130-170 sends credentials only on submit. No blanket login/auth
  // fetch exemption: unrelated requests and unexecuted actions remain unknown.
  return result();
}
