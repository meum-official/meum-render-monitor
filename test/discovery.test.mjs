import test from 'node:test';
import assert from 'node:assert/strict';
import { discover, publicRoom, classify, decodeXml } from '../discovery.mjs';

const base = {
  origins: ['https://meum.me', 'https://archive.meum.me'],
  sitemaps: [], extraPages: [], maxSitemaps: 10, maxRoomPages: 10,
};
const list = 'https://backend.meum.me/room/list';
const room = (id, patch = {}) => ({ id, open_type: 'public', status_id: 3, is_delete: 0, is_hide: 0, ...patch });
const xml = (...urls) => `<urlset>${urls.map(url => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;
const response = body => ({ ok: true, status: 200, json: async () => body, text: async () => body });

test('collects nested sitemap URLs, strips fragments, decodes query entities, and deduplicates', async () => {
  const a = 'https://meum.me/sitemap.xml';
  const b = 'https://meum.me/pages.xml';
  const fixtures = new Map([
    [a, `<sitemapindex><sitemap><loc>${b}</loc></sitemap><sitemap><loc>${a}</loc></sitemap></sitemapindex>`],
    [b, xml('https://meum.me/home#top', 'https://meum.me/home', 'https://meum.me/exhibition?sort=date&amp;page=1')],
  ]);
  const result = await discover({ ...base, sitemaps: [a] }, async url => response(fixtures.get(url)));
  assert.equal(result.complete, true);
  assert.equal(result.pages.length, 2);
  assert.ok(result.pages.some(p => p.url === 'https://meum.me/exhibition?sort=date&page=1'));
  assert.equal(result.sources.length, 2);
});

test('refuses unapproved sitemap origins before fetching them', async () => {
  const fetched = [];
  const result = await discover({ ...base, sitemaps: ['https://meum.me/map.xml'] }, async url => {
    fetched.push(url);
    return response('<sitemapindex><sitemap><loc>http://127.0.0.1/private.xml</loc></sitemap></sitemapindex>');
  });
  assert.equal(result.complete, false);
  assert.deepEqual(fetched, ['https://meum.me/map.xml']);
});

test('does not report complete when a sitemap contains an unapproved page origin', async () => {
  const result = await discover({ ...base, sitemaps: ['https://meum.me/map.xml'] }, async () => response(xml('https://other.example/')));
  assert.equal(result.complete, false);
  assert.equal(result.pages.length, 0);
});

test('fetches every list page and discovers current oneday id fallback', async () => {
  const seen = [];
  const result = await discover({ ...base, roomListUrl: list }, async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    seen.push(page);
    return response({ fullRoomCount: 51, result: page === 1
      ? Array.from({ length: 50 }, (_, i) => room(i + 1))
      : [room('public_day-01', { source_type: 'oneday' })] });
  });
  assert.equal(result.complete, true);
  assert.deepEqual(seen, [1, 2]);
  assert.equal(result.totalExhibitions, 51);
  assert.ok(result.pages.some(p => p.url === 'https://meum.me/oneday/public_day-01'));
});

test('excludes nonpublic, hidden and deleted rooms without treating exclusion as collection loss', async () => {
  const rows = [room(1), room(2, { open_type: 'private' }), room(3, { open_type: 'protect' }), room(4, { is_hide: 1 }), room(5, { is_delete: 1 }), room(6, { status_id: 1 })];
  const result = await discover({ ...base, roomListUrl: list }, async () => response({ result: rows, fullRoomCount: rows.length }));
  assert.equal(result.complete, true);
  assert.deepEqual(result.pages.map(p => p.url), ['https://meum.me/exhibition/preview/1']);
  assert.equal(result.totalExhibitions, 1);
  assert.equal(publicRoom(room(7, { status_id: '4' })), true);
});

test('a short response inconsistent with declared count is incomplete', async () => {
  const result = await discover({ ...base, roomListUrl: list }, async () => response({ fullRoomCount: 51, result: [room(1)] }));
  assert.equal(result.complete, false);
});

test('repeated pages cannot silently produce an all-pages result', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => room(i + 1));
  const result = await discover({ ...base, roomListUrl: list }, async () => response({ fullRoomCount: 101, result: rows }));
  assert.equal(result.complete, false);
  assert.match(result.errors.join(' '), /반복/);
});

test('configured list and sitemap limits report incomplete coverage', async () => {
  const listing = await discover({ ...base, maxRoomPages: 1, roomListUrl: list }, async () => response({ fullRoomCount: 51, result: Array.from({ length: 50 }, (_, i) => room(i + 1)) }));
  assert.equal(listing.complete, false);
  const maps = await discover({ ...base, maxSitemaps: 1, sitemaps: ['https://meum.me/one.xml', 'https://meum.me/two.xml'] }, async () => response(xml('https://meum.me/home')));
  assert.equal(maps.complete, false);
});

test('unknown public source types must mark coverage incomplete rather than increment a silent success', async () => {
  const result = await discover({ ...base, roomListUrl: list }, async () => response({ fullRoomCount: 1, result: [room('unhandled-public', { source_type: 'future-exhibition' })] }));
  assert.equal(result.complete, false);
  assert.equal(result.totalExhibitions, 0);
});

test('missing listing total cannot establish complete coverage', async () => {
  const result = await discover({ ...base, roomListUrl: list }, async () => response({ result: [room(1)] }));
  assert.equal(result.complete, false);
});

test('missing required publication fields mark schema drift incomplete rather than silently omit pages', async () => {
  const result = await discover({ ...base, roomListUrl: list }, async () => response({ fullRoomCount: 1, result: [{ id: 1 }] }));
  assert.equal(result.complete, false);
});

test('XML decoding preserves codepoints and route classification separates public viewers', () => {
  assert.equal(decodeXml('&#x1f7e2; &#38; &lt;'), '🟢 & <');
  assert.equal(classify('https://meum.me/oneday/a/viewer'), '3D 관람');
  assert.equal(classify('https://meum.me/oneday/a'), '전시 프리뷰');
  assert.equal(classify('https://archive.meum.me/archive/owner'), '아카이브');
});
