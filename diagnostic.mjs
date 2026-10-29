import { createHash } from 'node:crypto';
import { ruleFor } from './contracts.mjs';
import { resourceRole } from './resource-contracts.mjs';
export { resourceRole } from './resource-contracts.mjs';

export const DIAGNOSTIC_CAUSES = ['http-resource', 'network', 'policy-block', 'readiness', 'navigation', 'javascript', 'render', 'unclassified-resource'];
export const DIAGNOSTIC_REASONS = ['mutating-method', 'known-mutating-read', 'websocket-disabled', 'entry-navigation-not-executed', 'network-failed', 'pending'];
export const DIAGNOSTIC_EVIDENCE = ['document', 'application-script', 'stylesheet', 'viewer-password-bootstrap', 'viewer-room-bootstrap', 'viewer-scene-data', 'viewer-items', 'viewer-comments', 'viewer-seo', 'viewer-entry-preflight', 'preview-detail', 'invitation-intro', 'archive-room', 'webtoon-catalog', 'webtoon-likes', 'optional-session', 'optional-plan', 'optional-navigation-badge', 'optional-owner-profile', 'pricing-catalog', 'telemetry', 'media', 'unclassified'];
const severities = ['failure', 'warning', 'blocked', 'unknown'];
const roles = ['essential', 'optional', 'unknown'];
const policyCodes = ['aggregate-counter-repair', 'exhibition-auto-close', 'page-view-count', 'viewer-visit-and-migration', 'comment-default-create', 'scene-dto-migration', 'invitation-default-create', 'rose-claim-and-capability', 'password-attempt-state', 'socket-capability', 'board-view-count', 'invalid-url', 'not-known-mutating', ...DIAGNOSTIC_REASONS];
const services = new Set(['https://meum.me', 'https://www.meum.me', 'https://archive.meum.me', 'https://backend.meum.me', 'https://board.meum.me']);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const scalar = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const staticSegments = new Set('api rooms room roomById getDataJson password status socket-ticket viewer-entry public-invitation-settings invitation-settings comment-settings roses roomMission user room detail item userItem-list users me current login auth session members member my_plan simple_profile nodeApi billing check-new boards webtoon episodes likes public catalog metadata config exhibition exhibitions preview invitation introduction list exhibition-list archive viewer meum-lite-viewer oneday public-count view guestbooks owner report mine page meum creator home plan register cases galleries gallery en guides pricing get-started team school teachers teacher-guide customer-center notice event qna contact certificated sample-exhibition tools exhibition-poster ai-art-exhibition meum-service home2 index.html sitemap.xml robots.txt assets js css fonts build Build StreamingAssets'.split(' '));

export function safeLocation(raw, { sampling } = {}) {
  try {
    const url = new URL(raw);
    if (url.username || url.password || !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw Error();
    const service = services.has(url.origin);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const origin = service || local ? url.origin : `external:${hash(url.origin)}`;
    const selected = new Set(['previews', 'invitations', 'viewers'].flatMap(key => (sampling?.[key] || []).filter(row => row.eligible).flatMap(row => [String(row.roomId), row.hash].filter(Boolean))));
    const pathname = url.pathname;
    // Only the frontend's fingerprinted build tree retains filenames; uploads/media do not.
    if (service && url.hostname !== 'backend.meum.me' && (/^\/assets\/[A-Za-z][A-Za-z0-9_.-]*-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(pathname) || /^\/(?:unityMessage|main|app|service-worker)\.js$/.test(pathname))) return { origin, path: pathname };
    if (/\.(?:js|mjs|css|wasm|data|unityweb|png|jpe?g|gif|webp|svg|woff2?|mp[34]|glb|gltf|bin|json)(?:\.br|\.gz)?$/i.test(pathname)) {
      if (/^\/assets\/:asset-[a-f0-9]{12}\.(?:js|mjs|css|wasm|data|unityweb|png|jpe?g|gif|webp|svg|woff2?|mp[34]|glb|gltf|bin|json)(?:\.br|\.gz)?$/i.test(pathname)) return { origin, path: pathname };
      const extension = pathname.match(/\.(js|mjs|css|wasm|data|unityweb|png|jpe?g|gif|webp|svg|woff2?|mp[34]|glb|gltf|bin|json)(?:\.(br|gz))?$/i)?.[0].slice(1).toLowerCase() || 'asset';
      return { origin, path: `/assets/:asset-${hash(pathname)}.${extension}` };
    }
    const safe = pathname.split('/').map((segment, index, segments) => {
      if (!segment) return '';
      if (/^:(?:roomId|hash|owner|episode|publicId|masked-[a-f0-9]{12})$/.test(segment)) return segment;
      if (['creator', 'page', 'meum'].includes(segments[index - 1]) || segments[index - 1] === 'archive' && segment !== 'viewer' && segments[index - 2] !== 'api' || segments[index - 1] === 'webtoon' && segments[index - 2] !== 'api') return ':owner';
      if (segments[index - 1] === 'episodes') return ':episode';
      if (segments[index - 1] === 'oneday' && !['public-count', 'mine'].includes(segment)) return ':publicId';
      if (selected.has(segment)) return segment;
      if (/^\d+$/.test(segment)) return ':roomId';
      if (staticSegments.has(segment)) return segment;
      return `:masked-${hash(segment)}`;
    }).join('/') || '/';
    return { origin, path: safe };
  } catch { return { origin: 'invalid', path: '/:masked-invalid' }; }
}

export function createDiagnostics(target, sampling) {
  const requests = [], tracked = new WeakMap();
  let sequence = 0, droppedRequests = 0;
  const ensure = request => {
    if (tracked.has(request)) return tracked.get(request);
    const seq = ++sequence;
    if (requests.length >= 2000) { droppedRequests++; tracked.set(request, null); return null; }
    const row = { seq, requestId: `${target.id}-${seq}`, at: new Date().toISOString(), responseAt: null, completedAt: null, ...safeLocation(request.url(), { sampling }), method: request.method(), resourceType: request.resourceType(), status: null, blockedReason: 'pending', ...resourceRole({ url: request.url(), method: request.method(), resourceType: request.resourceType(), targetUrl: target.url }) };
    requests.push(row); tracked.set(request, row); return row;
  };
  return {
    requests, ensure,
    response(response) { const request = response.request(), row = ensure(request); if (row) { row.status = response.status(); row.responseAt = new Date().toISOString(); Object.assign(row, resourceRole({ url: request.url(), method: request.method(), resourceType: request.resourceType(), targetUrl: target.url, status: row.status })); } },
    finished(request) { const row = ensure(request); if (row && row.blockedReason === 'pending') { row.completedAt = new Date().toISOString(); row.blockedReason = null; } },
    fail(request) { const row = ensure(request); if (row && [null, 'pending', 'network-failed'].includes(row.blockedReason)) { row.completedAt = new Date().toISOString(); row.blockedReason = 'network-failed'; } },
    block(request, reason, policyCode = reason) { const row = ensure(request); if (row) { row.blockedReason = reason; row.policyCode = policyCode; row.completedAt = new Date().toISOString(); } },
    socket(url) { const seq = ++sequence; if (requests.length >= 2000) { droppedRequests++; return; } requests.push({ seq, requestId: `${target.id}-${seq}`, at: new Date().toISOString(), completedAt: new Date().toISOString(), ...safeLocation(url, { sampling }), method: 'WS', resourceType: 'websocket', status: null, blockedReason: 'websocket-disabled', policyCode: 'websocket-disabled', ...resourceRole({ url, method: 'WS', resourceType: 'websocket', targetUrl: target.url }) }); },
    visibleMedia(url) { const location = safeLocation(url, { sampling }); for (const row of requests) if (row.origin === location.origin && row.path === location.path) Object.assign(row, { role: 'essential', contract: 'media', sourceEvidence: 'media' }); },
    finish(issues, readiness, timeouts) {
      const groups = [], byKey = new Map();
      const add = (cause, severity, row, derivedKinds = []) => {
        const key = row ? JSON.stringify([cause, severity, row.origin, row.path, row.method, row.status, row.blockedReason, row.policyCode]) : `${cause}|${severity}`;
        let group = byKey.get(key);
        if (!group) { group = { cause, severity, count: 0, requestIds: [], derivedKinds: [] }; groups.push(group); byKey.set(key, group); }
        group.count++; if (row) group.requestIds.push(row.requestId);
        group.derivedKinds = [...new Set([...group.derivedKinds, ...derivedKinds])];
        return group;
      };
      for (const row of requests) {
        if (row.blockedReason && row.blockedReason !== 'pending') {
          const cause = row.blockedReason === 'network-failed' ? row.status >= 400 ? row.role === 'unknown' ? 'unclassified-resource' : 'http-resource' : 'network' : 'policy-block';
          const severity = row.role === 'optional' || row.blockedReason === 'entry-navigation-not-executed' ? 'warning' : cause === 'policy-block' ? 'blocked' : row.role === 'essential' ? 'failure' : 'unknown';
          add(cause, severity, row);
        } else if (row.status >= 400) add(row.role === 'unknown' ? 'unclassified-resource' : 'http-resource', row.role === 'essential' ? 'failure' : row.role === 'optional' ? 'warning' : 'unknown', row);
        else if (row.blockedReason === 'pending') add('unclassified-resource', row.role === 'optional' ? 'warning' : 'unknown', row);
      }
      const derived = issues.filter(issue => ['render-timeout', '3d-not-ready', 'loading', 'required-content', 'error-screen', 'empty-dom', 'blank-canvas', 'blank-screen'].includes(issue.kind)).map(issue => issue.kind);
      const blockedCore = requests.filter(row => row.role === 'essential' && row.blockedReason && !['network-failed', 'pending', 'entry-navigation-not-executed'].includes(row.blockedReason));
      if (derived.length) {
        const primary = groups.find(group => group.severity === 'failure' && ['http-resource', 'network'].includes(group.cause));
        if (primary) primary.derivedKinds = [...new Set([...primary.derivedKinds, ...derived])];
        else if (blockedCore.length) { const group = add('readiness', 'blocked', null, derived); group.requestIds = blockedCore.map(row => row.requestId); }
        else add('readiness', 'failure', null, derived);
      }
      for (const issue of issues) {
        if (['javascript', 'browser-crash'].includes(issue.kind)) add('javascript', 'failure');
        else if (['navigation', 'http', 'redirect'].includes(issue.kind)) { if (!groups.some(group => group.severity === 'failure')) add('navigation', blockedCore.length ? 'blocked' : 'failure'); }
        else if (['broken-image', 'broken-background'].includes(issue.kind)) add('render', 'failure');
        else if (['capture-unavailable', 'access-required', 'contract', 'entry-discovery'].includes(issue.kind)) add('render', 'unknown');
      }
      if (droppedRequests) add('unclassified-resource', 'unknown');
      if (blockedCore.length && derived.length) readiness.state = 'blocked';
      else if (derived.length) readiness.state = 'failed';
      const primary = groups.find(group => group.severity === 'failure') || groups.find(group => ['blocked', 'unknown'].includes(group.severity));
      return { schemaVersion: 1, requests: requests.map(row => ({ ...row })), groups, primaryCause: primary?.cause || null, droppedRequests, timeouts, readiness };
    }
  };
}

export function validateDiagnostics(source, { sampling, rowId, targetUrl } = {}) {
  if (source?.schemaVersion !== 1) return null;
  const requests = [];
  for (const row of (Array.isArray(source.requests) ? source.requests : []).slice(0, 2000)) {
    if (!Number.isSafeInteger(row.seq) || row.seq < 1 || !/^[a-f0-9]{20}-[1-9]\d*$/.test(row.requestId || '') || row.requestId !== `${rowId || row.requestId.split('-')[0]}-${row.seq}` || !iso(row.at)) continue;
    const location = /^(?:external:[a-f0-9]{12}|invalid)$/.test(row.origin || '') ? { ...safeLocation('https://backend.meum.me' + String(row.path || ''), { sampling }), origin: row.origin } : safeLocation(String(row.origin || '') + String(row.path || ''), { sampling });
    requests.push({ seq: row.seq, requestId: row.requestId, at: iso(row.at), responseAt: iso(row.responseAt), completedAt: iso(row.completedAt), ...location, method: /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE|WS)$/.test(row.method || '') ? row.method : 'OTHER', resourceType: ['document', 'script', 'stylesheet', 'image', 'media', 'font', 'xhr', 'fetch', 'websocket', 'manifest', 'texttrack', 'eventsource', 'other'].includes(row.resourceType) ? row.resourceType : 'other', status: Number.isInteger(row.status) && row.status >= 100 && row.status <= 599 ? row.status : null, blockedReason: DIAGNOSTIC_REASONS.includes(row.blockedReason) ? row.blockedReason : null, ...(policyCodes.includes(row.policyCode) ? { policyCode: row.policyCode } : {}), role: roles.includes(row.role) ? row.role : 'unknown', contract: DIAGNOSTIC_EVIDENCE.includes(row.contract) ? row.contract : 'unclassified', sourceEvidence: DIAGNOSTIC_EVIDENCE.includes(row.sourceEvidence) ? row.sourceEvidence : 'unclassified' });
  }
  const ids = new Set(requests.map(row => row.requestId));
  const groups = (Array.isArray(source.groups) ? source.groups : []).filter(group => DIAGNOSTIC_CAUSES.includes(group.cause) && severities.includes(group.severity)).slice(0, 2000).map(group => ({ cause: group.cause, severity: group.severity, count: scalar(group.count), requestIds: [...new Set((group.requestIds || []).filter(id => ids.has(id)))], derivedKinds: [...new Set((group.derivedKinds || []).filter(kind => ['render-timeout', '3d-not-ready', 'loading', 'required-content', 'error-screen', 'empty-dom', 'blank-canvas', 'blank-screen'].includes(kind)))] }));
  const registered = ruleFor(targetUrl || 'https://meum.me/home');
  const allowedCss = new Set(['selectors', 'loading', 'errors', 'unknownSelectors'].flatMap(key => registered[key] || []));
  const css = values => (Array.isArray(values) ? values : []).filter(value => allowedCss.has(value)).slice(0, 20);
  const observed = source.readiness?.observed;
  return { schemaVersion: 1, requests, groups, primaryCause: DIAGNOSTIC_CAUSES.includes(source.primaryCause) ? source.primaryCause : null, droppedRequests: scalar(source.droppedRequests) + Math.max(0, (source.requests?.length || 0) - requests.length), timeouts: { navigationMs: scalar(source.timeouts?.navigationMs), readinessMs: scalar(source.timeouts?.readinessMs) }, readiness: { state: ['ready', 'failed', 'blocked', 'unverified'].includes(source.readiness?.state) ? source.readiness.state : 'unverified', selectors: css(source.readiness?.selectors), requiredGlobal: source.readiness?.requiredGlobal === 'unityInstance' ? 'unityInstance' : null, loading: css(source.readiness?.loading), errorSelectors: css(source.readiness?.errorSelectors), elapsedMs: scalar(source.readiness?.elapsedMs), ...(observed ? { observed: { missingSelectors: css(observed.missingSelectors), visibleLoading: css(observed.visibleLoading), visibleErrorSelectors: css(observed.visibleErrorSelectors), globalReady: typeof observed.globalReady === 'boolean' ? observed.globalReady : null, accessGate: typeof observed.accessGate === 'boolean' ? observed.accessGate : null } } : {}) } };
}
