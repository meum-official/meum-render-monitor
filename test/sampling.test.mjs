import test from 'node:test';
import assert from 'node:assert/strict';
import { discover, classify } from '../discovery.mjs';
import { activePublicRoom, encodePublicRoomId, sampledRouteType } from '../sampling.mjs';

const room = (id, patch = {}) => ({ id, source_type: 'room', open_type: 'public', status_id: 3, is_expired: 0, start_at: '2020-01-01T00:00:00.000Z', end_at: '2099-01-01T00:00:00.000Z', ...patch });
// Most fixtures explicitly scope this contract to regular rooms/archive. Production
// defaults also enumerate the three unsupported known families, covered below.
const base = { origins: ['https://meum.me', 'https://archive.meum.me'], sitemaps: [], extraPages: [], roomListUrl: 'https://backend.meum.me/room/list', maxSitemaps: 10, maxRoomPages: 1000, sampling: { enabled: true, seed: 'fixed-fixture-seed', expectedFamilies: [] } };
const xml = urls => `<urlset>${urls.map(url => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => body });

function fixture(rows, options = {}) {
  const calls = [];
  const all = [...rows, ...(options.curatedRooms || [])];
  const byHash = new Map(all.map(row => [encodePublicRoomId(row.id), row]));
  const fetcher = async (raw, init) => {
    const url = new URL(raw); calls.push({ url, init });
    if (options.maps?.has(url.href)) return response(options.maps.get(url.href));
    if (url.pathname === '/room/list') {
      const page = Number(url.searchParams.get('page'));
      return response({ success: true, fullRoomCount: options.total ?? rows.length, result: options.listPage ? options.listPage(page) : rows.slice((page - 1) * 50, page * 50) });
    }
    if (url.pathname === '/exhibitions/exhibition-list') return response({ success: true, result: options.curated || [] });
    const archive = url.pathname.match(/^\/api\/archive\/rooms\/(\d+)$/);
    if (archive) {
      const row = options.archives?.find(item => item.id === Number(archive[1]));
      return row ? response({ success: true, result: row }) : response({ success: false }, 404);
    }
    const entry = url.pathname.match(/^\/api\/rooms\/(\d+)\/viewer-entry$/);
    if (entry) return response({ success: true, result: { room_id: Number(entry[1]), state: options.entryState || 'OPEN', ...(options.entryPatch || {}) } });
    const invitation = url.pathname.match(/^\/exhibition\/invitation\/([^/]+)\/introduction$/);
    if (invitation) {
      const row = byHash.get(invitation[1]);
      return row ? response({ success: true, result: { ...row, ...(options.introPatch || {}) } }) : response({ success: false }, 404);
    }
    throw new Error(`Unregistered fixture GET ${url.pathname}`);
  };
  return { calls, fetcher };
}

test('uses the current public codec and recognizes all capped route aliases', () => {
  assert.equal(encodePublicRoomId(4348), '4Q8xmY');
  assert.equal(encodePublicRoomId(4350), 'aX9ROo');
  assert.equal(encodePublicRoomId('4348'), null);
  assert.equal(sampledRouteType('https://meum.me/meum-lite-viewer?r=4Q8xmY'), 'viewer');
  assert.equal(sampledRouteType('https://meum.me/meum-lite-viewer/?r=4Q8xmY'), 'viewer');
  assert.equal(sampledRouteType('https://archive.meum.me/archive/ws_owner/4348'), 'viewer');
  assert.equal(classify('https://meum.me/exhibition/invitation/4Q8xmY'), '전시 초대장');
  assert.equal(classify('https://meum.me/meum-lite-viewer?r=4Q8xmY'), '3D 관람');
});

test('selects at most three same-room previews/invitations/viewers after public, active and guest proofs', async () => {
  const rejected = [room(30, { status_id: 4 }), room(31, { start_at: '2100-01-01' }), room(32, { end_at: '2001-01-01' }), room(33, { open_type: 'private' }), room(34, { is_hide: 1 }), room(35, { is_delete: 1 }), room(36, { password_protected: true }), room(37, { is_expired: 1 }), room(38, { status_id: 7 })];
  rejected.forEach(row => assert.equal(activePublicRoom(row), false));
  const f = fixture([room(4348), room(4350), room(4083), room(4327), ...rejected]);
  const result = await discover(base, f.fetcher);
  assert.equal(result.complete, true);
  assert.equal(result.pages.length, 9);
  const selected = result.sampling.previews.map(row => row.roomId);
  assert.equal(selected.length, 3);
  assert.deepEqual(result.sampling.invitations.map(row => row.roomId), selected);
  assert.deepEqual(result.sampling.viewers.map(row => row.roomId), selected);
  assert.ok(result.sampling.previews.every(row => row.eligible && row.passwordProtected === false));
  assert.ok(selected.every(id => [4348, 4350, 4083, 4327].includes(id)));
  assert.ok(f.calls.every(call => call.init.method === 'GET' && call.init.redirect === 'error'));
  assert.equal(f.calls.filter(call => call.url.pathname === '/room/list').length, 1);
  assert.ok(f.calls.filter(call => call.url.pathname === '/room/list').every(call => call.url.searchParams.get('is_expired') === 'false'));
  assert.equal(f.calls.filter(call => /viewer-entry$/.test(call.url.pathname)).length, 3);
  assert.equal(f.calls.filter(call => /introduction$/.test(call.url.pathname)).length, 3);
  assert.match(result.sampling.scope, /전수 검사 결과가 아닙니다/);
});

test('sitemap and extra-page IDs cannot reenter; static screens remain and repeated other types are represented once', async () => {
  const dynamic = Array.from({ length: 25 }, (_, i) => 8000 + i).flatMap(id => [
    `https://meum.me/exhibition/preview/${id}`, `https://meum.me/exhibition/${id}`, `https://meum.me/exhibition/invitation/${id}`,
    `https://meum.me/meum-lite-viewer?r=${id}`, `https://meum.me/meum-lite-viewer/?r=${id}`, `https://archive.meum.me/archive/viewer/${id}`, `https://archive.meum.me/archive/ws_owner/${id}`,
    `https://meum.me/oneday/day_${id}`, `https://meum.me/oneday/day_${id}/viewer`,
  ]);
  const staticUrls = ['https://meum.me/home', 'https://meum.me/plan', 'https://meum.me/en/pricing', 'https://meum.me/exhibition', 'https://archive.meum.me/'];
  const map = 'https://meum.me/map.xml';
  const f = fixture([room(4348), room(4350), room(4083)], { maps: new Map([[map, xml([...staticUrls, ...dynamic, 'https://meum.me/creator/ws_a', 'https://meum.me/creator/ws_b', 'https://archive.meum.me/archive/ws_a', 'https://archive.meum.me/archive/ws_b'])]]) });
  const result = await discover({ ...base, sitemaps: [map], extraPages: dynamic.map(url => ({ url })) }, f.fetcher);
  assert.equal(result.complete, false, 'unverified different workflows cannot silently count as fully covered');
  assert.deepEqual([...new Set(result.sampling.unavailable.map(row => row.family).filter(Boolean))].sort(), ['archive-viewer', 'oneday-preview', 'oneday-viewer']);
  assert.equal(result.pages.filter(page => sampledRouteType(page.url)).length, 9);
  assert.ok(staticUrls.every(url => result.pages.some(page => page.url === url)));
  assert.equal(result.pages.filter(page => page.group === '제작자').length, 1);
  assert.equal(result.pages.filter(page => /^\/archive\/ws_/.test(new URL(page.url).pathname)).length, 1);
  assert.ok(!result.pages.some(page => /800\d/.test(page.url)));
});

test('archive-only and sample invitation families are explicit gaps, even when normal public samples pass', async () => {
  const map = 'https://archive.meum.me/map.xml';
  const f = fixture([room(4348)], { maps: new Map([[map, xml(['https://archive.meum.me/', 'https://archive.meum.me/archive/viewer/123', 'https://meum.me/sample-exhibition/day_123/invitation'])]]) });
  const result = await discover({ ...base, sitemaps: [map] }, f.fetcher);
  assert.equal(result.complete, false);
  assert.ok(result.pages.some(row => row.url === 'https://archive.meum.me/'));
  assert.ok(!result.pages.some(row => /(?:day_123|viewer\/123)/.test(row.url)));
  assert.ok(result.sampling.unavailable.some(row => row.family === 'archive-viewer' && row.reason === 'route-family-not-verified'));
  assert.ok(result.sampling.unavailable.some(row => row.family === 'sample-invitation' && row.reason === 'route-family-not-verified'));
});

test('a public oneday API row cannot be silently replaced by a regular room workflow', async () => {
  const result = await discover(base, fixture([room('day_public', { source_type: 'oneday' }), room(4348)]).fetcher);
  assert.equal(result.complete, false);
  assert.ok(result.sampling.unavailable.some(row => row.family === 'oneday-preview'));
  assert.ok(result.sampling.unavailable.some(row => row.family === 'oneday-viewer'));
  assert.ok(!result.pages.some(row => row.url.includes('/oneday/')));
  const resumed = await discover(base, fixture([room(4348)]).fetcher, { sampling: result.sampling });
  assert.equal(resumed.complete, false, 'resume cannot erase an unverified functional family without verifying it');
  assert.ok(resumed.sampling.unavailable.some(row => row.family === 'oneday-preview'));
});

test('resume freezes identity and seed, revalidates chosen IDs and removes newly private targets without replacements', async () => {
  const rows = [room(1), room(2), room(3), room(4)];
  const first = await discover(base, fixture(rows).fetcher);
  const chosen = first.sampling.previews.map(row => row.roomId);
  const removed = chosen[0];
  const nextFixture = fixture(rows.map(row => row.id === removed ? { ...row, open_type: 'private' } : row));
  const next = await discover({ ...base, sampling: { ...base.sampling, seed: 'different-next-run-seed' } }, nextFixture.fetcher, { sampling: first.sampling });
  assert.equal(next.sampling.selectionId, first.sampling.selectionId);
  assert.equal(next.sampling.seed, first.sampling.seed);
  assert.equal(next.sampling.selectedAt, first.sampling.selectedAt);
  assert.equal(next.complete, false, 'an unavailable selected sample cannot produce a fully covered continuation');
  assert.deepEqual(next.sampling.previews.map(row => row.roomId), chosen);
  assert.equal(next.sampling.previews.find(row => row.roomId === removed).eligible, false);
  assert.ok(next.sampling.unavailable.some(row => row.roomId === removed));
  assert.ok(!next.pages.some(row => row.sampleRoomId === removed));
  assert.equal(nextFixture.calls.filter(call => call.url.pathname === '/room/list').length, 0);
  assert.equal(nextFixture.calls.filter(call => /viewer-entry$/.test(call.url.pathname)).length, 3);
});

test('mismatched or repeating public list counts stop metadata collection instead of falling back to an all-ID walk', async () => {
  const short = fixture([room(1)], { total: 51 });
  const missing = await discover(base, short.fetcher);
  assert.equal(missing.complete, false);
  assert.equal(missing.sampling.previews.length, 0);
  assert.equal(short.calls.filter(call => call.url.pathname === '/room/list').length, 1);
  const repeated = fixture(Array.from({ length: 50 }, (_, i) => room(i + 1)), { total: 1000, listPage: () => Array.from({ length: 50 }, (_, i) => room(i + 1)) });
  const repeatResult = await discover(base, repeated.fetcher);
  assert.equal(repeatResult.complete, false);
  assert.match(repeatResult.errors.join(' '), /반복/);
  assert.equal(repeated.calls.filter(call => call.url.pathname === '/room/list').length, 2);
});

test('bounded metadata pool is explicitly partial and never fetches every room page', async () => {
  const rows = Array.from({ length: 150 }, (_, i) => room(i + 1));
  const f = fixture(rows, { total: 1000 });
  const result = await discover(base, f.fetcher);
  assert.equal(result.complete, true, 'representative discovery is scoped to the declared bounded pool');
  assert.equal(result.sampling.pool.complete, false);
  assert.equal(result.sampling.pool.listed, 100);
  assert.equal(result.sampling.pool.declared, 1000);
  assert.equal(f.calls.filter(call => call.url.pathname === '/room/list').length, 2);
  assert.equal(result.sampling.previews.length, 3);
});

test('only a verified curator room_id can supply one fallback viewer; its exhibition id is never substituted', async () => {
  const f = fixture([], { curated: [{ id: 9, room_id: 77 }, { id: 10, room_id: 78 }], curatedRooms: [room(77), room(78)] });
  const result = await discover(base, f.fetcher);
  assert.equal(result.sampling.previews.length, 0);
  assert.equal(result.sampling.invitations.length, 0);
  assert.deepEqual(result.sampling.viewers.map(row => row.roomId), [77]);
  assert.equal(result.sampling.viewers[0].reason, 'verified-curator-fallback');
  assert.equal(result.pages.length, 1);
  assert.ok(!f.calls.some(call => /\/9\/viewer-entry$/.test(call.url.pathname)));
});

test('guest OPEN for a different room, protected introduction, or wrong invitation ID cannot become a sample', async () => {
  for (const options of [{ entryPatch: { room_id: 99 } }, { introPatch: { password_protected: true } }, { introPatch: { id: 99 } }, { entryState: 'ENDED_ARCHIVABLE' }]) {
    const result = await discover(base, fixture([room(1)], options).fetcher);
    assert.equal(result.sampling.previews.length, 0);
    assert.equal(result.sampling.viewers.length, 0);
    assert.ok(result.sampling.unavailable.some(row => row.type === 'viewer'));
  }
});

test('tampered resume hashes do not silently trigger replacement sampling', async () => {
  const first = await discover(base, fixture([room(1)]).fetcher);
  const previous = structuredClone(first.sampling); previous.invitations[0].hash = 'wrongHash';
  const f = fixture([room(2)]);
  const result = await discover(base, f.fetcher, { sampling: previous });
  assert.equal(result.complete, false);
  assert.equal(result.pages.length, 0);
  assert.equal(f.calls.filter(call => call.url.pathname === '/room/list').length, 0);
});

test('invalid resume seed or selectedAt fails closed before requests and never generates replacement metadata', async () => {
  const first = await discover(base, fixture([room(1)]).fetcher);
  for (const patch of [{ seed: null }, { seed: undefined }, { seed: '' }, { seed: '   ' }, { seed: 'x'.repeat(201) }, { selectedAt: null }, { selectedAt: undefined }]) {
    const f = fixture([room(2)]);
    const result = await discover(base, f.fetcher, { sampling: { ...first.sampling, ...patch } });
    assert.equal(result.complete, false);
    assert.equal(result.pages.length, 0);
    assert.equal(result.sampling, undefined, 'invalid previous metadata is not replaced with a fresh selection');
    assert.equal(f.calls.length, 0);
  }
});

test('empty public list plus empty curator and its continuation cannot report static-only complete coverage', async () => {
  const config = { ...base, extraPages: [{ url: 'https://meum.me/home' }] };
  const first = await discover(config, fixture([]).fetcher);
  assert.equal(first.complete, false);
  assert.equal(first.pages.length, 1);
  assert.ok(first.sampling.unavailable.some(row => row.type === 'viewer'));
  const resumed = await discover(config, fixture([]).fetcher, { sampling: first.sampling });
  assert.equal(resumed.complete, false);
  assert.equal(resumed.sampling.selectionId, first.sampling.selectionId);
  assert.ok(resumed.sampling.unavailable.some(row => row.type === 'preview'));
});

const archiveRoom = (patch = {}) => ({ id: 35, open_type: 'public', status_id: 4, is_archive: 1, archive_status: 'preserved', archive_start_at: '2023-10-31T02:21:09.000Z', archive_end_at: null, end_at: '2023-10-31T02:21:09.000Z', ...patch });
const archiveMap = 'https://archive.meum.me/map.xml';
const archiveUrl = 'https://archive.meum.me/archive/viewer/35';
const archiveConfig = { ...base, sitemaps: [archiveMap] };
const withArchive = (archives, patch = {}) => fixture([room(1), room(2), room(3)], { maps: new Map([[archiveMap, xml(['https://archive.meum.me/', archiveUrl])]]), archives, ...patch });

test('one sitemap-published active archive replaces one normal viewer slot and preserves the global cap', async () => {
  const f = withArchive([archiveRoom()]);
  const result = await discover(archiveConfig, f.fetcher);
  assert.equal(result.complete, true);
  assert.equal(result.sampling.previews.length, 3);
  assert.equal(result.sampling.invitations.length, 3);
  assert.equal(result.sampling.viewers.length, 3);
  assert.equal(result.sampling.viewers.filter(row => !row.family).length, 2);
  const archive = result.sampling.viewers.find(row => row.family === 'archive-viewer');
  assert.equal(archive.roomId, 35); assert.equal(archive.hash, null); assert.equal(archive.url, archiveUrl);
  assert.equal(archive.reason, 'active-public-archive'); assert.equal(archive.eligible, true);
  assert.equal(archive.eligibilityProof.archiveStatus, 'preserved');
  assert.ok(result.pages.some(row => row.url === archiveUrl));
  assert.ok(!result.sampling.unavailable.some(row => row.family === 'archive-viewer'));
  assert.equal(f.calls.filter(call => call.url.pathname === '/api/archive/rooms/35').length, 1);
  assert.ok(!f.calls.some(call => call.url.pathname === '/api/rooms/35/viewer-entry'), 'archive has its own active lifecycle; ordinary OPEN is not its proof');
});

test('unpublished extras and missing/private/closed/expired archive proof cannot supply the archive family', async () => {
  const extra = fixture([room(1)], { archives: [archiveRoom()] });
  const extrasResult = await discover({ ...base, extraPages: [{ url: archiveUrl }] }, extra.fetcher);
  assert.equal(extrasResult.complete, false);
  assert.ok(!extra.calls.some(call => call.url.pathname.startsWith('/api/archive/')));
  for (const patch of [null, { open_type: 'private' }, { archive_status: 'closed' }, { archive_end_at: '2001-01-01' }, { archive_start_at: '2100-01-01' }, { archive_status: undefined }, { is_archive: 0 }, { id: 99 }]) {
    const f = withArchive(patch === null ? [] : [archiveRoom(patch)]);
    const result = await discover(archiveConfig, f.fetcher);
    assert.equal(result.complete, false);
    assert.equal(result.sampling.viewers.length, 3);
    assert.ok(!result.pages.some(row => row.url === archiveUrl));
    assert.ok(result.sampling.unavailable.some(row => row.family === 'archive-viewer'));
  }
});

test('resume keeps an archive plaintext ID/null hash and rechecks its own public preservation window', async () => {
  const first = await discover(archiveConfig, withArchive([archiveRoom()]).fetcher);
  for (const patch of [{}, { open_type: 'private' }, { archive_end_at: '2001-01-01' }]) {
    const f = withArchive([archiveRoom(patch)]);
    const result = await discover(archiveConfig, f.fetcher, { sampling: first.sampling });
    const archive = result.sampling.viewers.find(row => row.family === 'archive-viewer');
    assert.equal(result.sampling.selectionId, first.sampling.selectionId);
    assert.equal(archive.roomId, 35); assert.equal(archive.hash, null); assert.equal(archive.url, archiveUrl);
    assert.equal(archive.eligible, !Object.keys(patch).length);
    assert.equal(result.complete, !Object.keys(patch).length);
    assert.equal(result.pages.some(row => row.url === archiveUrl), !Object.keys(patch).length);
    assert.equal(f.calls.filter(call => call.url.pathname === '/api/archive/rooms/35').length, 1);
    assert.ok(!f.calls.some(call => call.url.pathname === '/room/list'));
  }
});

test('default scope always exposes known unverified families without guessing IDs or calling mutating oneday reads', async () => {
  const config = { ...base, sampling: { enabled: true, seed: 'known-family-scope' } };
  const f = fixture([room(1), room(2), room(3)]);
  const result = await discover(config, f.fetcher);
  assert.equal(result.complete, false);
  assert.deepEqual(result.sampling.unavailable.filter(row => row.family).map(row => row.family).sort(), ['oneday-preview', 'oneday-viewer', 'sample-invitation']);
  assert.ok(result.sampling.unavailable.every(row => row.reason === 'no-published-public-id-and-readonly-proof' && !Object.hasOwn(row, 'url') && !Object.hasOwn(row, 'roomId')));
  assert.ok(!f.calls.some(call => call.url.pathname.startsWith('/api/oneday/')));
  const resumed = await discover(config, fixture([room(1), room(2), room(3)]).fetcher, { sampling: result.sampling });
  assert.equal(resumed.complete, false);
  assert.equal(resumed.sampling.selectionId, result.sampling.selectionId);
  assert.equal(resumed.sampling.unavailable.filter(row => row.family).length, 3);
});
