import { createHash, randomUUID } from 'node:crypto';
import Hashids from 'hashids';
import { knownMutatingRead } from './read-only-policy.mjs';

// Public route codec shared by 8301/src/utils/shortId.js and backend roomMetaService.js.
// This is published URL encoding, not an access credential; dependency pinned at 2.3.0.
const codec = new Hashids('Eunseo', 6);
const digest = value => createHash('sha256').update(value).digest('hex');
const count = (value, fallback, maximum) => Number.isInteger(value) && value >= 0 ? Math.min(value, maximum) : fallback;
const knownFamilies = { 'oneday-preview': 'preview', 'oneday-viewer': 'viewer', 'sample-invitation': 'invitation' };
export const samplingScope = '공개 일반 전시의 경로 유형별 대표 표본입니다. 전체 전시 전수 검사 결과가 아닙니다.';
export const encodePublicRoomId = roomId => Number.isSafeInteger(roomId) && roomId > 0 ? codec.encode(roomId) : null;

export function sampledRouteType(raw) {
  const { hostname, pathname: path } = new URL(raw);
  if (/^\/exhibition\/(?:preview\/)?\d+\/?$/.test(path) || /^\/oneday\/[^/]+\/?$/.test(path)) return 'preview';
  if (/^\/exhibition\/invitation\/[^/]+\/?$/.test(path) || /^\/sample-exhibition\/[^/]+\/invitation\/?$/.test(path)) return 'invitation';
  if (/^\/meum-lite-viewer\/?$/.test(path) || /\/viewer(?:\/|$)/.test(path) || hostname === 'archive.meum.me' && /^\/archive\/[^/]+\/\d+\/?$/.test(path)) return 'viewer';
  return null;
}

export function representativeRouteKey(raw) {
  const { hostname, pathname: path } = new URL(raw);
  if (/^\/creator\/[^/]+\/?$/.test(path)) return `${hostname}/creator/:id`;
  if (hostname === 'archive.meum.me' && /^\/archive\/[^/]+\/?$/.test(path)) return `${hostname}/archive/:owner`;
  if (/^\/webtoon\/[^/]+\/?$/.test(path)) return `${hostname}/webtoon/:episode`;
  return null;
}

export function activePublicRoom(row, now = Date.now()) {
  if (!row || row.open_type !== 'public' || Number(row.status_id) !== 3 || row.password_protected === true) return false;
  if (['is_delete', 'is_deleted', 'is_hide'].some(key => row[key] != null && Number(row[key]) !== 0)) return false;
  if (row.is_expired != null && Number(row.is_expired) !== 0) return false;
  const start = Date.parse(row.start_at), end = row.end_at == null || row.end_at === '' ? Infinity : Date.parse(row.end_at);
  return Number.isFinite(start) && start <= now && end > now;
}

export async function representativeSample(config, fetcher = fetch, previous, publishedArchives = []) {
  const options = config.sampling || {};
  const expectedFamilies = options.expectedFamilies ?? Object.keys(knownFamilies);
  if (!Array.isArray(expectedFamilies) || expectedFamilies.some(family => !Object.hasOwn(knownFamilies, family))) throw new Error('공개 기능 유형 검사 범위가 올바르지 않습니다.');
  const limits = { previews: count(options.previews, 3, 3), invitations: count(options.invitations, 3, 3), viewers: count(options.viewers, 3, 3), curatorFallback: 1, maxRoomPages: Math.max(1, count(options.maxRoomPages, 2, 3)), maxCandidateChecks: Math.max(1, count(options.maxCandidateChecks, 12, 20)) };
  const errors = [], sources = [], unavailable = [];
  const origin = options.publicOrigin || 'https://meum.me';
  if (!(config.origins || []).includes(origin)) throw new Error('표본 공개 출처가 허용 목록에 없습니다.');
  const api = new URL(config.roomListUrl);
  if (!['https:', 'http:'].includes(api.protocol) || api.username || api.password) throw new Error('공개 목록 출처가 올바르지 않습니다.');
  const get = async raw => {
    const url = new URL(raw, api.origin);
    if (url.origin !== api.origin || url.username || url.password) throw new Error('공개 메타데이터 출처가 다릅니다.');
    if (knownMutatingRead(url.href)) throw new Error('부작용이 있는 GET 경로는 공개 메타데이터 조회에 사용하지 않습니다.');
    const response = await fetcher(url.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body?.success === false) throw new Error('공개 메타데이터 응답이 성공하지 않았습니다.');
    return body;
  };
  const now = Date.now();
  const seed = previous ? previous.seed : options.seed ?? randomUUID();
  const selectedAt = previous ? previous.selectedAt : new Date(now).toISOString();
  const archiveProof = async (roomId, url) => {
    const canonical = `https://archive.meum.me/archive/viewer/${roomId}`;
    if (!Number.isSafeInteger(roomId) || roomId <= 0 || url !== canonical || !config.origins.includes('https://archive.meum.me')) throw new Error('archive-source-not-canonical');
    // .api/archive/archive.js -> archiveService.findPublicArchiveRoomById:
    // SELECTs and S3 ListObjectsV2 only; no visitor mutation or migration.
    const body = await get(`/api/archive/rooms/${roomId}`), info = body?.result;
    const start = info?.archive_start_at == null ? -Infinity : Date.parse(info.archive_start_at);
    const end = info?.archive_end_at == null ? Infinity : Date.parse(info.archive_end_at);
    if (body?.success !== true || info?.id !== roomId || info.open_type !== 'public' || ![3, 4].includes(Number(info.status_id)) || Number(info.is_archive) !== 1 || info.archive_status !== 'preserved' || !(start <= now && now <= end) || info.password_protected === true || ['is_hide', 'is_delete'].some(key => info[key] != null && Number(info[key]) !== 0)) throw new Error('archive-public-preserved-proof-failed');
    return { roomId, hash: null, family: 'archive-viewer', url: canonical, reason: 'active-public-archive', eligible: true, eligibilityProof: { source: 'GET /api/archive/rooms/:roomId', publication: 'public', archiveStatus: 'preserved', archiveStartAt: info.archive_start_at ?? null, archiveEndAt: info.archive_end_at ?? null } };
  };
  const proof = async roomId => {
    const hash = encodePublicRoomId(roomId);
    if (!hash || codec.decode(hash).length !== 1 || codec.decode(hash)[0] !== roomId) throw new Error('공개 ID 코덱 검증 실패');
    const [entry, introduction] = await Promise.all([get(`/api/rooms/${roomId}/viewer-entry`), get(`/exhibition/invitation/${hash}/introduction`)]);
    const info = introduction?.result;
    if (entry?.success !== true || entry.result?.room_id !== roomId || entry.result.state !== 'OPEN') throw new Error('guest-entry-not-open');
    if (introduction?.success !== true || info?.id !== roomId || !activePublicRoom(info, now)) throw new Error('invitation-public-active-proof-failed');
    // isProtected in current exhibitionPasswordPolicy only protects open_type=protect.
    // Older deployed servers omit the optional flag: public + guest OPEN proves this policy.
    return { roomId, hash, passwordProtected: false, passwordProof: info.password_protected === false ? 'public-api-explicit' : 'public-open-type-policy-and-guest-open' };
  };
  const entries = { previews: [], invitations: [], viewers: [] };
  let selectionId, pool;
  if (previous) {
    if (previous.schemaVersion !== 1 || previous.mode !== 'representative-sample' || typeof seed !== 'string' || !seed.trim() || seed.length > 200 || !/^[a-f0-9]{20}$/.test(previous.selectionId || '') || typeof selectedAt !== 'string' || selectedAt.length > 40 || !Number.isFinite(Date.parse(selectedAt))) throw new Error('이전 표본 선택 기록이 올바르지 않습니다.');
    selectionId = previous.selectionId;
    const checked = new Map();
    for (const [type, key] of [['preview', 'previews'], ['invitation', 'invitations'], ['viewer', 'viewers']]) {
      if (!Array.isArray(previous[key]) || previous[key].length > 3) throw new Error('이전 표본 한도가 올바르지 않습니다.');
      for (const row of previous[key]) {
        const archive = type === 'viewer' && row.family === 'archive-viewer';
        const hash = archive ? null : encodePublicRoomId(row.roomId);
        const expected = archive ? `https://archive.meum.me/archive/viewer/${row.roomId}` : type === 'preview' ? `${origin}/exhibition/preview/${row.roomId}` : type === 'invitation' ? `${origin}/exhibition/invitation/${hash}` : `${origin}/meum-lite-viewer?r=${hash}`;
        if ((!archive && !hash) || row.hash !== hash || row.url !== expected || archive && row.reason !== 'active-public-archive') throw new Error('이전 표본의 전시 ID와 경로가 다릅니다.');
        const proofKey = `${archive ? 'archive' : 'room'}:${row.roomId}`;
        if (!checked.has(proofKey)) checked.set(proofKey, await (archive ? archiveProof(row.roomId, row.url) : proof(row.roomId)).then(value => ({ value }), () => ({ error: 'selected-room-no-longer-eligible' })));
        const outcome = checked.get(proofKey);
        entries[key].push({ ...row, ...(archive && outcome.value ? outcome.value : {}), eligible: !outcome.error });
        if (outcome.error) {
          unavailable.push({ type, roomId: row.roomId, reason: outcome.error });
          errors.push(`선택 표본 현재 확인 불가: ${type} #${row.roomId}`);
        }
      }
    }
    pool = previous.pool;
    for (const row of previous.unavailable || []) if (['route-family-not-verified', 'no-published-public-id-and-readonly-proof'].includes(row.reason) && ['archive-viewer', 'oneday-preview', 'oneday-viewer', 'sample-invitation'].includes(row.family)) {
      unavailable.push({ type: row.type, family: row.family, reason: row.reason });
      errors.push(`대표 표본 유형 미검증: ${row.family}`);
    }
  } else {
    const rows = new Map(); let total, terminal = false, poolValid = true, pagesRead = 0;
    try {
      for (let page = 1; page <= limits.maxRoomPages; page++) {
        const url = new URL(api);
        url.search = new URLSearchParams({ page: String(page), card_per_page: '50', query: '', order: 'start_at', is_expired: 'false' }).toString();
        const body = await get(url.href); pagesRead++;
        if (!Array.isArray(body.result) || body.fullRoomCount == null || !Number.isInteger(Number(body.fullRoomCount)) || Number(body.fullRoomCount) < 0 || body.result.length > 50) throw new Error('공개 목록 형식 오류');
        const declared = Number(body.fullRoomCount);
        if (total !== undefined && total !== declared) throw new Error('공개 목록 개수가 수집 중 변경됐습니다.');
        total = declared; let added = 0;
        for (const row of body.result) {
          if (!row || typeof row !== 'object' || !['public', 'private', 'protect', 'host'].includes(row.open_type) || row.status_id == null) throw new Error('공개 상태 필드 오류');
          const key = `${row.source_type || 'room'}:${row.id}`;
          if (!rows.has(key)) { rows.set(key, row); added++; }
        }
        if (rows.size > total || (body.result.length < 50 && rows.size !== total)) throw new Error('공개 목록 개수 불일치');
        if (rows.size === total) { terminal = true; break; }
        if (!added) throw new Error('공개 목록 페이지 반복');
      }
    } catch (error) { poolValid = false; errors.push(`대표 표본 목록: ${error.message}`); }
    if ([...rows.values()].some(row => row.source_type === 'oneday')) {
      for (const [type, family] of [['preview', 'oneday-preview'], ['viewer', 'oneday-viewer']]) {
        unavailable.push({ type, family, reason: 'route-family-not-verified' });
        errors.push(`대표 표본 유형 미검증: ${family}`);
      }
    }
    const candidates = poolValid ? [...rows.values()].filter(row => (!row.source_type || row.source_type === 'room') && Number.isSafeInteger(row.id) && row.id > 0 && activePublicRoom(row, now)).sort((a, b) => digest(`${seed}|room|${a.id}`).localeCompare(digest(`${seed}|room|${b.id}`))) : [];
    pool = { listed: rows.size, declared: total ?? null, pagesRead, complete: terminal && poolValid, bounded: true, eligible: candidates.length };
    sources.push({ url: api.href, count: rows.size, scope: 'bounded-active-public-metadata-pool' });
    const selected = [];
    for (const candidate of candidates.slice(0, limits.maxCandidateChecks)) {
      if (selected.length >= Math.max(limits.previews, limits.invitations, limits.viewers)) break;
      try { selected.push(await proof(candidate.id)); }
      catch { unavailable.push({ type: 'selection', roomId: candidate.id, reason: 'public-active-guest-proof-failed' }); }
    }
    for (const [type, key] of [['preview', 'previews'], ['invitation', 'invitations'], ['viewer', 'viewers']]) for (const row of selected.slice(0, limits[key])) entries[key].push({ roomId: row.roomId, hash: row.hash, url: type === 'preview' ? `${origin}/exhibition/preview/${row.roomId}` : type === 'invitation' ? `${origin}/exhibition/invitation/${row.hash}` : `${origin}/meum-lite-viewer?r=${row.hash}`, reason: 'public-active-guest-open', eligible: true, passwordProtected: false, passwordProof: row.passwordProof });
    // A curator's id is an exhibition record, not its room_id. Never guess one.
    if (!entries.viewers.length && limits.viewers) {
      try {
        const curated = await get('/exhibitions/exhibition-list?limit=10&status_id=0');
        if (!Array.isArray(curated.result)) throw new Error('추천 전시 목록 형식 오류');
        for (const row of curated.result.slice(0, 10)) {
          if (!Number.isSafeInteger(row.room_id) || row.room_id <= 0) continue;
          try { const verified = await proof(row.room_id); entries.viewers.push({ roomId: verified.roomId, hash: verified.hash, url: `${origin}/meum-lite-viewer?r=${verified.hash}`, reason: 'verified-curator-fallback', eligible: true, passwordProtected: false, passwordProof: verified.passwordProof }); break; } catch { /* Invalid curator links cannot replace proof. */ }
        }
      } catch { /* An unavailable fallback is explicit below. */ }
    }
    if (limits.viewers) {
      const candidates = [...new Set(publishedArchives)].filter(url => /^https:\/\/archive\.meum\.me\/archive\/viewer\/[1-9]\d*$/.test(url)).sort((a, b) => digest(`${seed}|archive|${a}`).localeCompare(digest(`${seed}|archive|${b}`)));
      for (const url of candidates.slice(0, 5)) {
        try {
          const verified = await archiveProof(Number(new URL(url).pathname.split('/').at(-1)), url);
          entries.viewers = [...entries.viewers.slice(0, limits.viewers - 1), verified];
          break;
        } catch { /* Scheduled, closed, private or mismatched archives cannot fill this slot. */ }
      }
    }
    selectionId = digest(JSON.stringify({ seed, selectedAt, ids: Object.values(entries).flat().map(row => row.roomId) })).slice(0, 20);
  }
  for (const [type, key] of [['preview', 'previews'], ['invitation', 'invitations'], ['viewer', 'viewers']]) if (limits[key] && !entries[key].some(row => row.eligible)) {
    unavailable.push({ type, reason: 'no-verified-eligible-sample' });
    errors.push(`검증된 공개 표본 없음: ${type}`);
  }
  for (const family of expectedFamilies) {
    if (Object.values(entries).flat().some(row => row.family === family && row.eligible) || unavailable.some(row => row.family === family)) continue;
    // The existing oneday view/guestbook GET helpers call closeIfExpired().
    // An ID alone cannot authorize those mutating reads as an eligibility check.
    unavailable.push({ type: knownFamilies[family], family, reason: 'no-published-public-id-and-readonly-proof' });
    errors.push(`공개 ID·부작용 없는 확인 근거가 없는 기능 유형: ${family}`);
  }
  const sampling = { schemaVersion: 1, mode: 'representative-sample', selectedAt, selectionId, seed, limits: previous?.limits || limits, expectedFamilies: [...expectedFamilies], ...entries, unavailable, pool, scope: samplingScope, reason: '공개·진행 중·비인증 입장 가능 전시에서 실행별 고정 난수 순서로 선택했습니다.', codecSource: '8301_front-end/src/utils/shortId.js + backend/services/roomMetaService.js (Hashids 2.3.0)' };
  return { sampling, errors, sources, pages: Object.entries(entries).flatMap(([key, rows]) => rows.filter(row => row.eligible).map(row => ({ url: row.url, name: `${key === 'previews' ? '전시 프리뷰' : key === 'invitations' ? '전시 초대장' : '3D 관람'} 표본 #${row.roomId}`, sampleRoomId: row.roomId, sampleSelectionId: selectionId }))) };
}
