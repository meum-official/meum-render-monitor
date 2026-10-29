// Current local source shows state changes or capability issuance on these reads.
// A nonmatch is not a complete purity proof of arbitrary third-party handlers.
const mutatingReads = [
  [/^\/api\/oneday\/public-count\/?$/i, 'aggregate-counter-repair', 'oneday-public-count'],
  [/^\/api\/oneday\/[^/]+\/(?:view|guestbooks|owner|report)\/?$/i, 'exhibition-auto-close', 'oneday-lifecycle-read'],
  [/^\/api\/oneday\/mine\/?$/i, 'exhibition-auto-close', 'oneday-mine'],
  [/^\/page\/[^/]+\/?$/i, 'page-view-count', 'legacy-page'],
  [/^\/meum\/[^/]+\/[^/]+\/?$/i, 'viewer-visit-and-migration', 'legacy-meum-viewer'],
  [/^\/api\/rooms\/comment-settings\/[^/]+\/?$/i, 'comment-default-create', 'room-comment-settings'],
  [/^\/api\/rooms\/getDataJson\/?$/i, 'scene-dto-migration', 'room-scene-data'],
  [/^\/api\/rooms\/[^/]+\/invitation-settings\/?$/i, 'invitation-default-create', 'room-invitation-settings'],
  [/^\/api\/rooms\/[^/]+\/roses\/?$/i, 'rose-claim-and-capability', 'room-roses'],
  [/^\/api\/rooms\/[^/]+\/password\/status\/?$/i, 'password-attempt-state', 'room-password-status'],
  [/^\/api\/rooms\/[^/]+\/password\/socket-ticket\/?$/i, 'socket-capability', 'room-password-socket-ticket'],
  [/^\/boards\/[+\d.-][^/]*\/?$/i, 'board-view-count', 'board-detail'],
];

export const READ_POLICY_CODES = Object.freeze([...new Set(mutatingReads.map(([, code]) => code)), 'invalid-url', 'not-known-mutating']);

export function readPolicyDecision(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid-url');
    const pathname = decodeURIComponent(url.pathname);
    const match = mutatingReads.find(([pattern]) => pattern.test(pathname));
    return match ? { blocked: true, code: match[1], endpoint: match[2] } : { blocked: false, code: 'not-known-mutating', endpoint: 'other-read' };
  } catch { return { blocked: true, code: 'invalid-url', endpoint: 'invalid-url' }; }
}

export function knownMutatingRead(raw) {
  return readPolicyDecision(raw).blocked;
}
