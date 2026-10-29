import { representativeSample, sampledRouteType, representativeRouteKey } from './sampling.mjs';
import { knownMutatingRead } from './read-only-policy.mjs';

export const decodeXml = (text) => text.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
  const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  return named[entity] ?? String.fromCodePoint(entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10));
});

export function classify(url) {
  const u = new URL(url);
  if (/^\/exhibition\/invitation\/[^/]+\/?$/.test(u.pathname) || /^\/sample-exhibition\/[^/]+\/invitation\/?$/.test(u.pathname)) return '전시 초대장';
  if (/^\/exhibition\/preview\/\d+\/?$/.test(u.pathname) || /^\/oneday\/[^/]+\/?$/.test(u.pathname)) return '전시 프리뷰';
  if (/^\/meum-lite-viewer\/?$/.test(u.pathname) || /\/viewer(?:\/|$)/.test(u.pathname) || u.hostname === 'archive.meum.me' && /^\/archive\/[^/]+\/\d+\/?$/.test(u.pathname)) return '3D 관람';
  if (u.hostname === 'archive.meum.me') return '아카이브';
  if (/^\/creator\//.test(u.pathname)) return '제작자';
  if (/^\/exhibition\/\d+/.test(u.pathname)) return '전시 상세';
  return '공개 화면';
}

export function publicRoom(row) {
  return row.open_type === 'public' && [3, 4].includes(Number(row.status_id)) && !Number(row.is_delete) && !Number(row.is_hide);
}

export async function discover(config, fetcher = fetch, previous = {}) {
  const pages = new Map();
  const errors = [];
  const sources = [];
  let totalExhibitions = 0;
  const samplingEnabled = config.sampling?.enabled === true;
  const otherTypes = new Set();
  const unverifiedFamilies = new Map();
  const publishedArchives = new Set();
  let representative;
  const allowed = new Set(config.origins);
  const add = (raw, name, selected, published = false) => {
    const u = new URL(raw);
    if (!allowed.has(u.origin) || !['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error(`허용되지 않은 공개 URL: ${u.origin}`);
    if (samplingEnabled && !selected) {
      const type = sampledRouteType(u.href);
      if (type) {
        // A regular room sample does not establish these different application flows.
        const family = u.hostname === 'archive.meum.me' && type === 'viewer' ? 'archive-viewer'
          : /^\/oneday\/[^/]+\/viewer\/?$/.test(u.pathname) ? 'oneday-viewer'
          : /^\/oneday\/[^/]+\/?$/.test(u.pathname) ? 'oneday-preview'
          : /^\/sample-exhibition\/[^/]+\/invitation\/?$/.test(u.pathname) ? 'sample-invitation' : null;
        if (family) unverifiedFamilies.set(family, type);
        if (published && family === 'archive-viewer' && /^https:\/\/archive\.meum\.me\/archive\/viewer\/[1-9]\d*$/.test(u.href)) publishedArchives.add(u.href);
        return;
      }
      const key = representativeRouteKey(u.href);
      if (key && otherTypes.has(key)) return;
      if (key) otherTypes.add(key);
    }
    u.hash = '';
    const url = u.href;
    if (!pages.has(url)) pages.set(url, { url, name: name || `${u.hostname}${u.pathname}`, group: classify(url), ...(selected ? { sampleRoomId: selected.sampleRoomId, sampleSelectionId: selected.sampleSelectionId } : {}) });
  };
  const get = async (url, type) => {
    if (knownMutatingRead(url)) throw new Error('부작용이 있는 GET 경로는 공개 수집에 사용하지 않습니다.');
    const r = await fetcher(url, { method: 'GET', signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return type === 'json' ? r.json() : r.text();
  };
  for (const page of config.extraPages || []) add(page.url, page.name);
  const seen = new Set();
  const pending = [...config.sitemaps];
  while (pending.length) {
    const url = pending.shift();
    if (seen.has(url)) continue;
    if (seen.size >= config.maxSitemaps) { errors.push('사이트맵 수집 한도 도달: 목록이 완전하지 않습니다.'); break; }
    seen.add(url);
    try {
      const u = new URL(url);
      if (!allowed.has(u.origin)) throw new Error('허용되지 않은 사이트맵 출처');
      const xml = await get(url);
      if (!/<(?:sitemapindex|urlset)(?:\s|>)/i.test(xml)) throw new Error('사이트맵 XML이 아닙니다.');
      const locs = [...xml.matchAll(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi)].map(m => decodeXml(m[1].trim()));
      if (/<sitemapindex(?:\s|>)/i.test(xml)) pending.push(...locs);
      else for (const loc of locs) add(loc, undefined, undefined, true);
      sources.push({ url, count: locs.length });
    } catch (e) { errors.push(`${url}: ${e.message}`); }
  }
  if (samplingEnabled) {
    try {
      representative = await representativeSample(config, fetcher, previous.sampling, [...publishedArchives]);
      for (const row of representative.pages) add(row.url, row.name, row);
      for (const [family, type] of unverifiedFamilies) {
        if (family === 'archive-viewer' && representative.sampling.viewers.some(row => row.family === family && row.eligible)) continue;
        if (representative.sampling.unavailable.some(row => row.family === family)) continue;
        representative.sampling.unavailable.push({ type, family, reason: 'route-family-not-verified' });
        errors.push(`대표 표본 유형 미검증: ${family}`);
      }
      errors.push(...representative.errors);
      sources.push(...representative.sources);
    } catch (error) { errors.push(`대표 표본: ${error.message}`); }
  } else if (config.roomListUrl) {
    let expected;
    let terminal = false;
    const ids = new Set();
    for (let page = 1; page <= config.maxRoomPages; page++) {
      try {
        const u = new URL(config.roomListUrl);
        u.search = new URLSearchParams({ page: String(page), card_per_page: '50', query: '', order: 'start_at', is_expired: 'all' }).toString();
        const body = await get(u.href, 'json');
        if (!Array.isArray(body.result)) throw new Error('공개 목록 result 배열이 없습니다.');
        const rows = body.result;
        if (body.fullRoomCount === undefined || body.fullRoomCount === null || !Number.isInteger(Number(body.fullRoomCount)) || Number(body.fullRoomCount) < 0) throw new Error('전체 공개 목록 개수를 확인할 수 없습니다.');
        const declared = Number(body.fullRoomCount);
        if (Number.isFinite(declared) && declared >= 0) {
          if (expected !== undefined && expected !== declared) throw new Error('수집 중 공개 목록 개수가 변경됐습니다. 다음 점검에서 다시 확인합니다.');
          expected = declared;
        }
        let added = 0;
        for (const row of rows) {
          if (!row || typeof row !== 'object' || !['public', 'private', 'protect', 'password'].includes(row.open_type) || !Number.isInteger(Number(row.status_id)) || row.status_id == null) throw new Error('공개 상태 필드가 올바르지 않습니다.');
          const key = `${row.source_type || 'room'}:${row.publicId || row.public_id || row.id}`;
          if (ids.has(key)) continue;
          ids.add(key); added++;
          if (!publicRoom(row)) continue;
          if (row.source_type === 'oneday') {
            const id = row.publicId || row.public_id || row.id;
            if (!id || !/^[a-zA-Z0-9_-]+$/.test(String(id))) throw new Error('원데이 전시 공개 ID 형식을 확인할 수 없습니다.');
            add(`https://meum.me/oneday/${id}`, row.title || row.name);
          } else if (!row.source_type || row.source_type === 'room') {
            if (!/^[1-9]\d*$/.test(String(row.id))) throw new Error('전시 ID 형식 오류');
            add(`https://meum.me/exhibition/preview/${row.id}`, row.title || row.name);
          } else throw new Error(`알 수 없는 공개 전시 유형: ${row.source_type}`);
          totalExhibitions++;
        }
        if (!rows.length || rows.length < 50 || (expected !== undefined && ids.size >= expected)) {
          if (expected !== undefined && ids.size !== expected) throw new Error(`공개 목록 누락: ${ids.size}/${expected}`);
          terminal = true; sources.push({ url: config.roomListUrl, count: ids.size }); break;
        }
        if (!added) throw new Error('페이지가 반복되어 전체 공개 목록을 확인하지 못했습니다.');
      } catch (e) { errors.push(`${config.roomListUrl}: ${e.message}`); terminal = true; break; }
    }
    if (!terminal) errors.push('공개 전시 페이지 수집 한도 도달: 목록이 완전하지 않습니다.');
  }
  totalExhibitions = new Set([...pages.values()].filter(p => p.group === '전시 프리뷰').map(p => p.url)).size;
  const priority = (p) => (config.priorityPages || []).includes(p.url) ? -1 : p.group === '전시 프리뷰' ? 1 : p.group === '공개 화면' ? 0 : 2;
  return { pages: [...pages.values()].sort((a, b) => priority(a) - priority(b)), complete: errors.length === 0, source: samplingEnabled ? '공개 정적 화면 + 경로 유형별 대표 표본' : '공개 사이트맵 + 비인증 공개 전시 목록', totalExhibitions, sources, errors, ...(representative ? { sampling: representative.sampling } : {}) };
}
