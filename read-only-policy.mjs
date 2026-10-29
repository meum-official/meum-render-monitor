// These GET handlers can repair counters, close exhibitions, create defaults or migrate data.
const mutatingReads = [
  /^\/api\/oneday\/public-count\/?$/i,
  /^\/api\/oneday\/[^/]+\/(?:view|guestbooks|owner|report)\/?$/i,
  /^\/api\/oneday\/mine\/?$/i,
  /^\/page\/[^/]+\/?$/i,
  /^\/meum\/[^/]+\/[^/]+\/?$/i,
  /^\/api\/rooms\/comment-settings\/[^/]+\/?$/i,
  /^\/api\/rooms\/getDataJson\/?$/i,
  /^\/api\/rooms\/[^/]+\/invitation-settings\/?$/i,
  /^\/api\/rooms\/[^/]+\/roses\/?$/i,
  /^\/api\/rooms\/[^/]+\/password\/status\/?$/i,
  /^\/boards\/[+\d.-][^/]*\/?$/i,
];

export function knownMutatingRead(raw) {
  try {
    const pathname = decodeURIComponent(new URL(raw).pathname);
    return mutatingReads.some(pattern => pattern.test(pathname));
  } catch { return true; }
}
