import { productSourceRoot, reviewedSourceFile } from '../../product-source.mjs';
// Actual Admin/Experience SFCs + current backend authorization/route code, with memory-only models.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { BUSINESS_SOURCE_FILES } from '../../business-contracts.mjs';

const workspace = productSourceRoot(true);
const adminRoot = path.join(workspace, '8302_adminMeum-master');
const backendRoot = path.join(workspace, '8080_meum-backend-api-develop/meum-backend-api-develop');
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const roomId = 991002; // Existing invitationExperiencePolish memory room.
const actorId = 104; // Existing accepted_invited_participant_3 in backend-policy-fixture.cjs.

async function sourceFixture() {
  const source = await readFile(path.join(adminRoot, 'tests/invitationExperiencePolish.browser.mjs'), 'utf8');
  const html = source.match(/const html = String\.raw`([\s\S]*?)`;\r?\n\r?\nconst server=/)?.[1];
  assert.ok(html, 'existing actual-component fixture HTML boundaries changed');
  const start = html.indexOf('const clone=value=>');
  const end = html.indexOf('const fixture={');
  assert.ok(start >= 0 && end > start);
  const declarations = html.slice(start, end);
  assert.doesNotMatch(declarations, /\brequire\s*\(|\bfetch\s*\(|process\.|axios/);
  const seeds = vm.runInNewContext(`${declarations}\n({rooms,invitations,comments,roses});`, {}, { timeout: 1000 });
  const room = clone(seeds.rooms.get(roomId));
  assert.equal(room.id, roomId); assert.equal(room.owner_id, 991101);
  return { source, html, room, invitation: clone(seeds.invitations.get(roomId)), comment: clone(seeds.comments.get(roomId)), rose: clone(seeds.roses.get(roomId)) };
}

export async function createReadonlyBackendPolicy(room) {
  productSourceRoot();
  // Every VM receives fresh mocks. Application models/config/env/network modules are never required.
  const counters = { policyInvocations: 0, inviteReads: 0, workspaceReads: 0, transactions: 0, roomSaves: 0 };
  const baseline = clone(room);
  const stored = { ...clone(room), async save() { counters.roomSaves++; } };
  const sourceHashes = {};
  const load = async (relative, dependencies) => {
    const source = await readFile(path.join(backendRoot, relative), 'utf8');
    sourceHashes[relative] = hash(source);
    const context = { module: { exports: {} }, console: { log() {}, warn() {}, error() {} }, require(name) {
      if (!Object.hasOwn(dependencies, name)) throw Error(`Unmocked backend dependency denied: ${name}`);
      return dependencies[name];
    } };
    vm.runInNewContext(source, context, { filename: relative, timeout: 1000 });
    return context.module.exports;
  };
  const DB = {
    api_room: { async findOne({ where }) { assert.equal(Number(where.id), roomId); return stored; }, async findByPk(id) { assert.equal(Number(id), roomId); return stored; } },
    room_invite: { async findOne({ where }) {
      assert.equal(Number(where.room_id), roomId); assert.equal(Number(where.user_id), actorId);
      assert.equal(where.is_state, 1); assert.equal(where.deleted_at, null); counters.inviteReads++;
      return { is_auth: 3, is_state: 1, deleted_at: null };
    } },
    api_workspace: { async findOne() { return { id: 9911, type: 'organization', organization_id: null }; } },
    api_workspace_member: { async findOne() { counters.workspaceReads++; return null; } },
    sequelize: { async transaction(callback) { counters.transactions++; return callback({ LOCK: { UPDATE: 'FIXTURE_UPDATE' } }); } },
  };
  const organization = { fail: (code, status) => Object.assign(new Error(code), { code, status }), getUserOrganizationRole: async () => null, canManageOrganization: async () => false };
  const workspacePolicy = await load('services/workspaceService.js', {
    sequelize: { Op: {} }, '../models': DB, './organizationService': organization, './organizationPlanService': {}, '../utils/publicId': {},
  });
  const masterPolicy = await load('utils/roomMaster.js', {});
  const permissions = await load('services/organizationRoomService.js', {
    '../models': DB, './organizationService': organization, './workspaceService': workspacePolicy,
    '../utils/roomMaster': masterPolicy, './roomPublication': { available: () => true }, './internalOperatorAccess': { isInternalOperatorAccess: () => false },
  });
  const routes = [];
  const router = { use() {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) router[method] = (route, ...handlers) => routes.push({ method, route, handler: handlers.at(-1) });
  const noop = () => {};
  const chain = new Proxy(noop, { apply: () => chain, get: () => chain });
  const multer = Object.assign(() => ({ single: () => noop }), { memoryStorage: () => ({}) });
  await load('.api/rooms/rooms.js', {
    express: { Router: () => router }, multer, 'express-validator': { body: chain, param: chain, query: chain, validationResult: noop },
    '../../middleware/validator': { validatorErrorCallback: noop }, '../../services/roomService': { findRoomById: async () => stored },
    '../../utils/galleryDecoration': { gallerySaveError: () => null }, '../../services/commentService': {}, '../../services/userService': {},
    '../../middleware/email-sender': {}, '../../middleware/jwt': { auth: noop }, '../../services/reservationEmailService': {}, '../../middleware/slack': {},
    '../../models': DB, '../../config/s3.config': {}, '../../utils/serversideUserKey': {}, 'express-rate-limit': { rateLimit: () => noop, ipKeyGenerator: noop },
    '../../utils/commentModeration': {}, '../../routes/roomCopy': {}, '../../routes/roomMission': {}, '../../services/organizationService': organization,
    '../../services/organizationRoomService': permissions, '../../services/workspaceService': workspacePolicy,
    '../../services/workspacePlanGuardService': { requireRoomActivePlan: async () => {} }, '../../services/roomEntryService': {},
    '../../services/internalOperatorAccess': { getVerifiedAccountAccess: () => null }, '../../services/exhibitionActivationService': {},
    '../../services/exhibitionAuditService': {}, '../../services/domainNotificationService': {}, '../../services/roseService': { lockedRoom: async () => stored },
  });
  const route = routes.find(value => value.method === 'patch' && value.route === '/update_room');
  assert.ok(route, 'current update_room handler missing');
  return { counters, sourceHashes, snapshot: () => clone(stored), baseline,
    async denySave(body) {
      counters.policyInvocations++;
      let status = 200, result;
      const response = { status(value) { status = value; return response; }, json(value) { result = value; return response; } };
      await route.handler({ decoded: { user_id: actorId }, params: {}, body }, response, error => { throw error; });
      return { status, body: clone(result) };
    },
  };
}

export async function createReadonlyBackendFixture() {
  productSourceRoot();
  return createReadonlyBackendPolicy((await sourceFixture()).room);
}

const noNetworkDevClient = `const styles=new Map();export const createHotContext=()=>({data:{},accept(){},acceptExports(){},dispose(){},prune(){},on(){},off(){},send(){},invalidate(){}});export function updateStyle(id,css){let el=styles.get(id);if(!el){el=document.createElement('style');styles.set(id,el);document.head.appendChild(el);}el.textContent=css;}export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}export const injectQuery=(url,q)=>url+(url.includes('?')?'&':'?')+q;`;

export async function createReadonlyBusinessFixture(directory) {
  productSourceRoot();
  const seed = await sourceFixture();
  const policy = await createReadonlyBackendPolicy(seed.room);
  const require = createRequire(path.join(adminRoot, 'package.json'));
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const vue = (await import(pathToFileURL(require.resolve('@vitejs/plugin-vue')).href)).default;
  const adapterStart = seed.html.indexOf('axios.defaults.adapter=async config=>{');
  const storeStart = seed.html.indexOf('const store=createStore(');
  assert.ok(adapterStart >= 0 && storeStart > adapterStart);
  let html = seed.html.slice(0, adapterStart) + `axios.defaults.headers.common['X-Meum-Monitor-Test-Role']='read-only';\n` + seed.html.slice(storeStart);
  const replacements = [
    ['id:991101,name:', 'id:104,name:'], ['is_auth:0,isExpired:', 'is_auth:2,isExpired:'],
    ['roomId:991001,roomInfo:clone(rooms.get(991001))', 'roomId:991002,roomInfo:clone(rooms.get(991002))'],
    ["fetchAndSetRoomInfo({commit}){const room=clone(rooms.get(store.state.userInfo.roomId));commit('setRoomInfo',room);return room;}", "async fetchAndSetRoomInfo({commit}){const {data}=await axios.get('/mock/user/room/detail?room_id=991002');commit('setRoomInfo',data.result);return data.result;}"],
  ];
  for (const [before, after] of replacements) { assert.ok(html.includes(before), `fixture source boundary changed: ${before.slice(0, 45)}`); html = html.replace(before, after); }
  assert.ok(!html.includes('axios.defaults.adapter='), 'UI must make real loopback HTTP reads');
  const requests = [], rejected = [];
  let responseFault = null;
  let marker;
  const json = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };
  const server = await createServer({ root: adminRoot, configFile: false, envFile: false, mode: 'test', logLevel: 'error', appType: 'custom',
    // Reuse compiled dependencies only; every server's HTTP/model/role state above remains fresh.
    cacheDir: path.join(workspace, 'tools/meum-render-monitor/data/business-harness/readonly-vite-cache'),
    plugins: [{ name: 'actual-readonly-ui-current-backend-memory-policy', enforce: 'pre', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname.replace(/^\/mock(?=\/)/, '');
      // The current development i18n compiler needs eval. This policy exists only in this loopback memory fixture.
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; frame-src 'none'; form-action 'none'; base-uri 'none'");
      if (url.pathname === '/.well-known/meum-monitor-isolation') return json(res, 200, marker);
      if (url.pathname === '/@vite/client') { res.setHeader('Content-Type', 'text/javascript'); res.end(noNetworkDevClient); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        requests.push({ method: req.method, path: pathname, role: req.headers['x-meum-monitor-test-role'] || null });
        if (req.method !== 'PATCH' || pathname !== '/api/rooms/update_room' || req.headers['x-meum-monitor-test-role'] !== 'read-only') { rejected.push(pathname); return json(res, 403, { success: false, code: 'FIXTURE_MUTATION_DENIED' }); }
        try {
          let bytes = '';
          for await (const chunk of req) { bytes += chunk; if (bytes.length > 8192) throw Error('oversized fixture body'); }
          const body = JSON.parse(bytes);
          if (Number(body.room_id) !== roomId || body.solution_json !== seed.room.solution_json || Object.keys(body).some(key => !['room_id', 'solution_json'].includes(key))) return json(res, 400, { success: false, code: 'FIXTURE_SCOPE_DENIED' });
          const result = await policy.denySave(body);
          if (responseFault === 'negative-patch-http200') return json(res, 200, { success: true, fixtureCounterexample: true, actualPolicyStatus: result.status });
          return json(res, result.status, result.body);
        } catch { return json(res, 500, { success: false, code: 'FIXTURE_POLICY_FAILURE' }); }
      }
      if (/^\/(?:api|user|room)\//.test(pathname)) {
        requests.push({ method: req.method, path: pathname, role: req.headers['x-meum-monitor-test-role'] || null });
        if (pathname === '/user/room/detail' && Number(url.searchParams.get('room_id')) === roomId) return json(res, 200, { success: true, result: policy.snapshot() });
        if (pathname === `/api/rooms/comment-settings/${roomId}`) return json(res, 200, { success: true, result: seed.comment });
        if (pathname === `/api/rooms/${roomId}/roses/settings`) return json(res, 200, { success: true, result: { ...seed.rose, baseSettings: { enabled: seed.rose.enabled, galleryId: seed.rose.galleryId, items: seed.rose.anchors } } });
        if (pathname === `/api/rooms/${roomId}/invitation-settings`) return json(res, 200, { success: true, result: seed.invitation });
        if (pathname.endsWith('/userItem-list')) return json(res, 200, []);
        if (pathname.endsWith('/simple_profile')) return json(res, 200, { result: { nickname: '합성 주최자' } });
        if (pathname.endsWith('/cheer_count')) return json(res, 200, { success: true, cheer_count: 0 });
        if (pathname.endsWith('/users')) return json(res, 200, { result: [{ id: actorId }] });
        if (pathname.endsWith('/deco_purchase_list') || pathname.endsWith('/notices')) return json(res, 200, { success: true, result: [] });
        if (pathname.endsWith('/status_id')) return json(res, 200, { success: true, status_id: 0 });
        rejected.push(pathname); return json(res, 404, { success: false, code: 'FIXTURE_READ_NOT_REGISTERED' });
      }
      if (url.pathname === '/__polish-image.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#3565C5"/></svg>'); return; }
      if (url.pathname === '/exhibition/experience' || url.pathname === '/exhibition/ticket') { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml(req.url, html)); return; }
      next();
    }); } }, vue()],
    resolve: { alias: { '@': path.join(adminRoot, 'src') } },
    css: { preprocessorOptions: { scss: { additionalData: (source, filename) => filename.replaceAll('\\', '/').endsWith('/common/base/_globals.scss') ? source : '@use "@/assets/scss/common/globals-public" as *;\n' + source, silenceDeprecations: ['legacy-js-api', 'import', 'global-builtin', 'color-functions'] } } },
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vuex', 'vue-router', 'axios', 'vue-i18n', 'dayjs', 'vue-advanced-cropper', 'lodash/throttle', 'qrcode', 'qrcode.vue', 'hashids', 'vue3-cookies'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, open: false, fs: { allow: [adminRoot, path.join(workspace, '8301_front-end/src/shared'), path.join(workspace, '8301_front-end/src/utils/exhibitionDescription.js')] } },
  });
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const sourceProof = {};
    for (const id of ['admin-experience-ui', 'admin-room-read', 'admin-experience-fixture', 'room-update-routes', 'room-permissions', 'room-workspace-service', 'room-master-policy', 'business-readonly-server']) {
      assert.ok(BUSINESS_SOURCE_FILES[id], `root integration must register source key ${id}`);
      sourceProof[id] = hash(await readFile(reviewedSourceFile(BUSINESS_SOURCE_FILES[id])));
    }
    const manifest = { schemaVersion: 1, environmentId: 'current-readonly-ui-http-backend-policy-memory', kind: 'fixture', adapter: 'source-ui-http-fixture-v1',
      origin, serverGuardId: 'meum-memory-business-fixture-v1', productionForwarding: false, existingAccountsOnly: true,
      negativePermissionProbes: true, database: { mode: 'memory' }, dataset: { roomId, existing: true }, roles: { 'read-only': actorId }, sourceProof,
      scenarios: { 'viewer-settings-readonly': { pagePath: '/exhibition/experience' } },
    };
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
    const manifestSha256 = hash(bytes);
    marker = { environmentId: manifest.environmentId, manifestSha256, serverGuardId: manifest.serverGuardId, productionForwarding: false, mutationsRestrictedToDataset: true, existingAccountsOnly: true, negativePermissionProbes: true, dataset: manifest.dataset, roles: manifest.roles };
    await mkdir(directory, { recursive: true });
    const manifestPath = path.join(directory, 'readonly-isolation.json');
    await writeFile(manifestPath, bytes);
    return { server, origin, manifestPath, manifestSha256, scenarioIds: ['viewer-settings-readonly'], policy, requests, rejected, sourceProof,
      injectResponseFault(mode) { assert.ok(mode === null || mode === 'negative-patch-http200'); responseFault = mode; },
      evidence: { identity: { actorId, roomId, uiPermission: 2, acceptedInvitePermission: 3 }, ui: 'current Admin.vue + ExhibitionExperience.vue from existing component harness', backend: 'current update_room + organizationRoomService + workspaceService + roomMaster in strict dependency-whitelist VMs', syntheticAuth: true, productionRequests: 0, databaseConnections: 0, accountsCreated: 0 },
    };
  } catch (error) { await server.close(); throw error; }
}
