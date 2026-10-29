// Actual AutoSettingBox UI -> localhost HTTP -> current DTO method -> isolated memory only.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createCurrentAutoInstallMemoryFixture } from './auto-install.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const admin = path.join(workspace, '8302_adminMeum-master');
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const noNetworkClient = `const styles=new Map();export const createHotContext=()=>({data:{},accept(){},acceptExports(){},dispose(){},prune(){},on(){},off(){},send(){},invalidate(){}});export function updateStyle(id,text){let node=styles.get(id);if(!node){node=document.createElement('style');styles.set(id,node);document.head.appendChild(node);}node.textContent=text;}export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}export const injectQuery=(url,query)=>url+(url.includes('?')?'&':'?')+query;`;

export async function createAutoInstallBusinessFixture(directory, { readbackFault = null, failNextInstall = false } = {}) {
  if (![null, 'wrong-startpoint'].includes(readbackFault)) throw new Error('Unregistered memory-only readback fault');
  const memory = await createCurrentAutoInstallMemoryFixture();
  const require = createRequire(path.join(admin, 'package.json'));
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const { default: vue } = await import(pathToFileURL(require.resolve('@vitejs/plugin-vue')).href);
  const runId = `auto-install-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const output = path.resolve(directory, runId);
  await mkdir(output, { recursive: true });
  const metadata = { runId, startedAt: new Date().toISOString(), endedAt: null, exitCode: null, requests: 0, installsAttempted: 0, installsSucceeded: 0, installsFailed: 0, independentReads: 0, rejectedMutations: 0, databaseConnections: 0, productionMutations: 0, accountsCreated: 0, sourceProof: {} };
  const logPath = path.join(output, 'requests.jsonl');
  const metadataPath = path.join(output, 'server-meta.json');
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  const record = async entry => { metadata.requests++; await appendFile(logPath, JSON.stringify({ sequence: metadata.requests, at: new Date().toISOString(), ...entry }) + '\n'); };
  let marker, manifest, origin;
  let failNext = failNextInstall;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><main><h1>Isolated auto-install component</h1><div id="app"></div></main><script type="module">
import {createApp,h} from 'vue';import {createStore} from 'vuex';import {createRouter,createWebHistory} from 'vue-router';import {createI18n} from 'vue-i18n';
import AutoSettingBox from '/src/components/artwork/modal/AutoSettingBox.vue';import ko from '/src/i18n/locales/ko.json';
const store=createStore({state:{api:{back:location.origin,token:''},userInfo:{roomId:991001,is_auth:0,isExpired:0,roomInfo:{thumbnail_url:'https://graphic-box.s3.fixture.invalid/thumbnail.png'}},module:{invenItem:[991002,991003]}}});
const router=createRouter({history:createWebHistory(),routes:[{path:'/artwork',component:{render:()=>null}}]});
const app=createApp({render:()=>h(AutoSettingBox,{totalPosts:2})});app.use(store);app.use(router);app.use(createI18n({legacy:false,locale:'ko',messages:{ko}}));await router.isReady();app.mount('#app');
</script><style>body{font:16px system-ui;padding:24px}button{cursor:pointer}main{max-width:900px}.auto-setting-wrap{margin:30px 0}</style></body></html>`;
  const send = (response, status, body) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store'); response.end(JSON.stringify(body)); };
  const server = await createServer({
    root: admin, configFile: false, envFile: false, envDir: output, envPrefix: 'MEUM_FIXTURE_PUBLIC_', mode: 'test', publicDir: false, logLevel: 'error',
    cacheDir: path.join(output, 'vite-cache'), plugins: [vue({ template: { transformAssetUrls: { includeAbsolute: false } } }), { name: 'meum-auto-install-isolated-memory', configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        const method = request.method;
        const role = request.headers['x-meum-monitor-test-role'];
        // The current vue-i18n development compiler evaluates the checked-in locale messages.
        // This permission applies only to this isolated localhost component harness.
        response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
        try {
          if (url.pathname === '/@vite/client') { response.setHeader('Content-Type', 'text/javascript'); response.end(noNetworkClient); return; }
          if (url.pathname === '/.well-known/meum-monitor-isolation') return send(response, 200, marker);
          if (/\/(?:\.env|\.git|\.aws|\.codex)(?:[./]|$)/i.test(url.pathname)) return send(response, 403, { success: false });
          if (method === 'GET' && url.pathname === '/resource/icon/info-circle.svg') { response.setHeader('Content-Type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#7357d8"/></svg>'); return; }
          if (method === 'GET' && url.pathname === '/artwork') { response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml('/artwork', html)); return; }
          const apiPath = url.pathname.startsWith('/api/') || ['/room/991001', '/lands/list', '/item/userItem-list', '/user/room/detail'].includes(url.pathname);
          if (!apiPath) { if (!['GET', 'HEAD'].includes(method)) return send(response, 405, { success: false }); return next(); }
          if (role !== 'owner') { if (!['GET', 'HEAD'].includes(method)) metadata.rejectedMutations++; await record({ method, path: url.pathname, result: 'role-rejected' }); return send(response, 403, { success: false }); }
          const room = memory.read();
          if (method === 'GET' && url.pathname === '/room/991001') { await record({ method, path: url.pathname, result: 'ui-read' }); return send(response, 200, { ...room, detail: JSON.stringify(room.detail), 'owner.user_id': room.owner_id, 'owner.nickname': 'Synthetic owner' }); }
          if (method === 'GET' && url.pathname === '/lands/list') { await record({ method, path: url.pathname, result: 'land-read' }); return send(response, 200, [{ id: 10, detail: { title: 'Synthetic land10' } }]); }
          if (method === 'GET' && url.pathname === '/item/userItem-list' && url.searchParams.get('room_id') === String(memory.dataset.roomId)) { await record({ method, path: url.pathname, result: 'item-read' }); return send(response, 200, memory.items); }
          if (method === 'GET' && url.pathname === '/user/room/detail' && url.searchParams.get('room_id') === String(memory.dataset.roomId)) {
            metadata.independentReads++;
            if (readbackFault === 'wrong-startpoint' && memory.stats().saves) room.startPoint_json = JSON.stringify({ position: { x: 999, y: 999, z: 999 }, eulerAngle: { x: 0, y: 0, z: 0 } });
            await record({ method, path: url.pathname, result: 'independent-read', saves: memory.stats().saves });
            return send(response, 200, { success: true, result: room });
          }
          if (method === 'POST' && url.pathname === '/api/rooms/991001/auto-install') {
            const chunks = []; let bytes = 0;
            for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) throw new Error('Fixture request is too large'); chunks.push(chunk); }
            let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(response, 400, { success: false }); }
            if (!body || body.landId !== 10 || !same(body.itemIds, memory.dataset.itemIds) || Object.keys(body).some(key => !['landId', 'itemIds'].includes(key))) { metadata.rejectedMutations++; await record({ method, path: url.pathname, result: 'dataset-rejected' }); return send(response, 403, { success: false }); }
            metadata.installsAttempted++;
            if (failNext) { failNext = false; metadata.installsFailed++; await record({ method, path: url.pathname, result: 'synthetic-failure', attempt: metadata.installsAttempted }); return send(response, 503, { success: false, message: 'Synthetic temporary failure' }); }
            const installed = await memory.install(body);
            if (installed.success) metadata.installsSucceeded++; else metadata.installsFailed++;
            await record({ method, path: url.pathname, result: installed.success ? 'saved' : 'method-failed', attempt: metadata.installsAttempted, saves: memory.stats().saves });
            return send(response, installed.success ? 200 : 400, installed);
          }
          if (!['GET', 'HEAD'].includes(method)) metadata.rejectedMutations++;
          await record({ method, path: url.pathname, result: 'unregistered' });
          return send(response, 404, { success: false });
        } catch { await record({ method, path: url.pathname, result: 'fixture-error' }); return send(response, 500, { success: false, message: 'Isolated fixture error' }); }
      });
    } }],
    resolve: { alias: { '@': path.join(admin, 'src') }, dedupe: ['vue', 'vuex', 'vue-router', 'vue-i18n', 'axios'] },
    css: { preprocessorOptions: { scss: { additionalData: '@use "@/assets/scss/common/constants/colors" as *;\n@use "@/assets/scss/common/constants/z-index" as *;\n@use "@/assets/scss/common/mixin/responsive" as *;\n', silenceDeprecations: ['legacy-js-api', 'import', 'global-builtin', 'color-functions'] } } },
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vuex', 'vue-router', 'vue-i18n', 'axios', '@lucide/vue'] },
    server: { host: '127.0.0.1', port: 0, open: false, hmr: false, watch: null, fs: { allow: [admin], deny: ['**/.env', '**/.env.*', '**/.git/**', '**/.aws/**', '**/.codex/**'] } },
  });
  try {
    await server.listen();
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const files = { ...memory.sourceProof };
    for (const [key, relative] of Object.entries({ 'auto-install-ui': '8302_adminMeum-master/src/components/artwork/modal/AutoSettingBox.vue', 'auto-install-ui-policy': '8302_adminMeum-master/src/policies/exhibitionPolicy.js', 'auto-install-confirm-ui': '8302_adminMeum-master/src/components/common/modal/ConfirmSmallModal.vue', 'business-auto-install-server': 'tools/meum-render-monitor/fixtures/business/auto-install-server.mjs' })) files[key] = hash(await readFile(path.join(workspace, relative)));
    manifest = { schemaVersion: 1, kind: 'fixture', adapter: 'auto-install-component-v1', environmentId: 'actual-auto-install-component-memory', origin, serverGuardId: 'meum-memory-business-fixture-v1', productionForwarding: false, existingAccountsOnly: true, database: { mode: 'memory' }, dataset: memory.dataset, roles: { owner: 'synthetic-existing-owner-991100' }, sourceProof: files, scenarios: { 'auto-install': { pagePath: '/artwork' } } };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    const manifestSha256 = hash(manifestBytes);
    marker = { environmentId: manifest.environmentId, manifestSha256, serverGuardId: manifest.serverGuardId, productionForwarding: false, mutationsRestrictedToDataset: true, existingAccountsOnly: true, dataset: manifest.dataset, roles: manifest.roles };
    metadata.sourceProof = files;
    const manifestPath = path.join(output, 'auto-install-isolation.json');
    await writeFile(manifestPath, manifestBytes);
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    return { server, origin, manifest, manifestPath, manifestSha256, scenarioIds: ['auto-install'], output, logPath, metadataPath,
      memorySnapshot: () => memory.read(), originalItems: memory.items, template: memory.template,
      snapshot: () => ({ ...structuredClone(metadata), memory: memory.stats() }),
      async close(exitCode = 0) { metadata.endedAt = new Date().toISOString(); metadata.exitCode = exitCode; metadata.memory = memory.stats(); await writeFile(metadataPath, JSON.stringify(metadata, null, 2)); await server.close(); },
      limits: ['Actual UI and localhost HTTP use the current DTO method with synthetic memory data.', 'This does not establish real JWT/DB authorization, SQL transaction semantics, image metadata availability or Unity rendering.'],
    };
  } catch (error) { metadata.endedAt = new Date().toISOString(); metadata.exitCode = 1; await writeFile(metadataPath, JSON.stringify(metadata, null, 2)); await server.close(); throw error; }
}
