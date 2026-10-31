import { productSourceRoot, reviewedSourceFile } from '../../product-source.mjs';
// Actual creator-feedback Vue + actual survey routes/services; only existing synthetic models/auth are replaced.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { BUSINESS_SOURCE_FILES } from '../../business-contracts.mjs';

const root = productSourceRoot(true);
const admin = path.join(root, '8302_adminMeum-master');
const backend = path.join(root, '8080_meum-backend-api-develop/meum-backend-api-develop');
const hash = value => createHash('sha256').update(value).digest('hex');
const scenarioIds = ['survey-target-included', 'survey-target-excluded', 'survey-submit-admin-read'];
const sourceIds = ['survey-api', 'survey-modal', 'survey-admin', 'survey-routes', 'survey-service', 'survey-eligibility', 'survey-target-ui', 'survey-state', 'survey-loading', 'survey-policy', 'survey-results-service', 'survey-backend-fixture-test', 'survey-validator', 'business-survey-server'];
const identities = { 'eligible-creator': { user_id: 7 }, 'excluded-creator': { user_id: 8 }, 'super-admin': { user_id: 7, is_root: true }, staff: { user_id: 7, is_root: true }, 'impersonated-creator': { user_id: 7, impersonation: { fixture: true } } };

function backendFixture() {
  const requireBackend = createRequire(path.join(backend, 'package.json'));
  const mocks = new Map();
  const context = vm.createContext({ Date, Promise, structuredClone, Buffer, console: { log() {}, error() {}, warn() {} }, process: { env: { CREATOR_VOC_ENABLED: 'true' } } });
  const modules = new Map();
  const allowed = new Set(['config/creatorVoc.js', 'services/surveyService.js', 'services/creatorVocEligibility.js', 'services/creatorVocService.js', 'routes/survey.js', 'middleware/validator.js']);
  const op = Object.fromEntries(['and', 'or', 'in', 'lte', 'gte', 'gt'].map(key => [key, Symbol.for(key)]));
  const auth = (request, response, next) => {
    const actor = identities[request.headers['x-meum-monitor-test-role']];
    if (!actor) return response.status(401).json({ success: false, code: 'FIXTURE_ROLE_REQUIRED' });
    request.decoded = { ...actor };
    return next();
  };
  const jwt = { auth, authRoot(request, response, next) { return auth(request, response, () => request.decoded.is_root ? next() : response.status(403).json({ success: false, code: 'FIXTURE_ADMIN_REQUIRED' })); } };
  function load(relative) {
    if (!allowed.has(relative)) throw new Error(`Unapproved synthetic backend module: ${relative}`);
    if (modules.has(relative)) return modules.get(relative).exports;
    const filename = path.join(backend, relative);
    const module = { exports: {} };
    modules.set(relative, module);
    const restrictedRequire = id => {
      if (id === 'sequelize') return { Op: op };
      if (id === 'uuid') return { v4: randomUUID };
      if (id === 'express' || id === 'express-validator') return requireBackend(id);
      if (id === 'jsonwebtoken') return { verify() { throw new Error('Real JWT verification is disabled in this fixture'); } };
      if (!id.startsWith('.')) throw new Error(`Unapproved fixture dependency: ${id}`);
      const target = path.relative(backend, path.resolve(path.dirname(filename), id)).replaceAll('\\', '/') + (path.extname(id) ? '' : '.js');
      if (target === 'middleware/jwt.js') return jwt;
      if (target === 'models.js') return mocks.get('../../models');
      const key = '../../' + target.replace(/\.js$/, '');
      if (mocks.has(key)) return mocks.get(key);
      return load(target);
    };
    vm.runInContext(`(function(require,module,exports){\n${readFileSync(filename, 'utf8')}\n})`, context, { filename })(restrictedRequire, module, module.exports);
    return module.exports;
  }
  context.jest = { fn: fn => fn, mock: (id, factory) => mocks.set(id, factory()), requireActual: id => {
    if (id !== '../../config/creatorVoc') throw new Error('Only current survey policy can be loaded');
    return load('config/creatorVoc.js');
  } };
  // Reuse the reviewed 45-test transaction/rollback model harness, without executing its tests or importing models.
  const harness = readFileSync(path.join(backend, 'test/unit/creatorVoc.test.js'), 'utf8');
  const boundary = harness.indexOf('const DB = require("../../models");');
  if (boundary < 0) throw new Error('Current creator VOC memory harness boundary changed');
  const tables = vm.runInContext(harness.slice(0, boundary) + '\nmockTables;', context);
  const policy = mocks.get('../../config/creatorVoc');
  tables.api_survey.push({ id: 11, title: 'Creator feedback', target: policy.target, status: 'active', dismiss_key: 'fixture-v1', start_at: null, end_at: null, priority: 0 });
  tables.api_survey_question.push(...policy.questions.map((question_text, index) => ({ id: 101 + index, survey_id: 11, question_text, type: 'short_text', is_required: index === 0 ? 1 : 0, sort_order: index, max_length: 2000 })));
  tables.api_subscription.push({ id: 21, user_id: 7, organization_id: null, payment_id: 31, plan_code: 'basic_1month', status: 'active', start_at: '2020-01-01', end_at: '2100-01-01' });
  tables.api_payments.push({ id: 31, user_id: 7, organization_id: null, provider: 'iamport', imp_uid: 'fixture-pg-31', product_type: 'subscription', plan_code: 'basic_1month', amount: 110000, status: 'paid', refund_amount: 0, cancelled_at: null, paid_at: '2020-01-01', raw_payload_json: { status: 'paid', amount: 110000, imp_uid: 'fixture-pg-31', sandbox: false, cancel_amount: 0 } });
  tables.api_workspace.push({ id: 41, type: 'personal', owner_user_id: 7, organization_id: null, status: 'active', deleted_at: null });
  tables.api_room.push({ id: 51, workspace_id: 41, owner_id: 7, is_delete: 0, data_json: '{"saved":true}' });
  return { router: load('routes/survey.js'), voc: load('services/creatorVocService.js'), counts: () => ({ answerRows: tables.api_survey_answer.length, responses: new Set(tables.api_survey_answer.map(row => row.response_key)).size, participants: tables.api_survey_participant.length, productionMutations: 0, databaseConnections: 0, accountsCreated: 0 }) };
}

const devClient = `const styles=new Map();
export const createHotContext=()=>({data:{},accept(){},acceptExports(){},dispose(){},prune(){},on(){},off(){},send(){},invalidate(){}});
export function updateStyle(id,content){let node=styles.get(id);if(!node){node=document.createElement('style');styles.set(id,node);document.head.appendChild(node);}node.textContent=content;}
export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}
export const injectQuery=(url,query)=>url+(url.includes('?')?'&':'?')+query;`;

function entry(role) {
  const actor = identities[role] || identities['excluded-creator'];
  return `import {createApp,h,onMounted,nextTick} from 'vue';
import axios from 'axios';
import {createStore} from 'vuex';
import {createRouter,createWebHistory} from 'vue-router';
import CreatorFeedbackModal from '/src/components/feedback/CreatorFeedbackModal.vue';
import {useCreatorFeedback,armCreatorFeedbackInvitation} from '/src/composables/useCreatorFeedback.js';
const settled=()=>setTimeout(async()=>{await nextTick();document.body.dataset.surveyFixtureReady='true';},0);
axios.interceptors.response.use(response=>{const pathname=new URL(response.config.url,location.origin).pathname;if(pathname==='/surveys/creator-voc'&&(!response.data.eligibility?.eligible||!response.data.state?.can_auto_prompt)||pathname==='/surveys/11/creator-voc/prompt')settled();return response;});
const store=createStore({state:{userInfo:{id:${actor.user_id},logined:true,impersonation:{isImpersonating:${!!actor.impersonation}}},api:{back:location.origin,token:'synthetic-local-fixture-only'}}});
const router=createRouter({history:createWebHistory(),routes:[{path:'/exhibition-dashboard',component:{render:()=>null}}]});
const Host={setup(){const feedback=useCreatorFeedback();onMounted(async()=>{await nextTick();armCreatorFeedbackInvitation();document.body.classList.add('survey-fixture-ready');if(${!!actor.impersonation})settled();});return()=>h('main',[h('h1','격리된 실제 설문 컴포넌트'),h('p','기존 합성 계정·메모리 저장소'),h('button',{class:'creator-feedback-entry',onClick:feedback.openFeedback},'의견 남기기'),h(CreatorFeedbackModal)]);}};
const app=createApp(Host);app.use(store);app.use(router);await router.isReady();app.mount('#app');`;
}

export async function createSurveyBusinessFixture(directory, { adminReadback = 'normal' } = {}) {
  productSourceRoot();
  if (!['normal', 'missing'].includes(adminReadback)) throw new Error('Unknown synthetic fault mode');
  const memory = backendFixture();
  await memory.voc.recordSuccessfulSave({ userId: 7, excluded: false }, 51);
  const requireAdmin = createRequire(path.join(admin, 'package.json'));
  const requireBackend = createRequire(path.join(backend, 'package.json'));
  const { createServer } = await import(pathToFileURL(requireAdmin.resolve('vite')).href);
  const { default: vue } = await import(pathToFileURL(requireAdmin.resolve('@vitejs/plugin-vue')).href);
  const express = requireBackend('express');
  const api = express();
  const requests = [];
  api.use((request, response, next) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const allowed = request.method === 'GET' && ['/surveys/creator-voc', '/surveys/admin/11/results'].includes(pathname) || request.method === 'POST' && ['/surveys/11/creator-voc/prompt', '/surveys/11/creator-voc/answers'].includes(pathname);
    requests.push({ method: request.method, path: pathname, role: identities[request.headers['x-meum-monitor-test-role']] ? request.headers['x-meum-monitor-test-role'] : 'unregistered', allowed });
    if (!allowed) return response.status(403).json({ success: false, code: 'FIXTURE_ENDPOINT_DENIED' });
    if (adminReadback === 'missing' && pathname === '/surveys/admin/11/results') {
      const json = response.json.bind(response);
      response.json = value => json(value?.result?.questions ? { ...value, result: { ...value.result, questions: value.result.questions.map(row => ({ ...row, text_answers: [] })) } } : value);
    }
    next();
  });
  api.use(express.json({ limit: '16kb' }));
  api.use('/surveys', memory.router);
  api.use((_error, _request, response, _next) => response.status(500).json({ success: false, code: 'SYNTHETIC_SURVEY_ERROR' }));
  await mkdir(directory, { recursive: true });
  const entryPlugin = { name: 'existing-survey-fixture-entry', resolveId(id) { if (/^\/survey-fixture-entry-[a-z-]+\.js$/.test(id)) return id; }, load(id) { const match = id.match(/^\/survey-fixture-entry-([a-z-]+)\.js$/); if (match && identities[match[1]]) return entry(match[1]); } };
  // Color tokens preserve actual component styles without the global stylesheet's external Google font import.
  const server = await createServer({ root: admin, configFile: false, envDir: false, mode: 'test', plugins: [entryPlugin, vue()], cacheDir: path.join(directory, 'vite-cache'), resolve: { alias: { '@': path.join(admin, 'src') } }, css: { preprocessorOptions: { scss: { additionalData: '@use "@/assets/scss/common/constants/colors" as *;\n', silenceDeprecations: ['legacy-js-api', 'import', 'global-builtin', 'color-functions'] } } }, optimizeDeps: { noDiscovery: true, include: ['vue', 'vuex', 'vue-router', 'axios'] }, server: { host: '127.0.0.1', port: 0, open: false, hmr: false, watch: null, fs: { strict: true, allow: [admin] } } });
  let marker;
  let origin;
  server.middlewares.stack.unshift({ route: '', handle(request, response, next) {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.headers.origin && request.headers.origin !== origin) { response.statusCode = 403; return response.end('Fixture origin denied'); }
    response.setHeader('Cache-Control', 'no-store');
    if (pathname === '/.well-known/meum-monitor-isolation') { response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify(marker)); }
    if (pathname.startsWith('/surveys')) return api(request, response, next);
    if (pathname === '/@vite/client') { response.setHeader('Content-Type', 'text/javascript'); return response.end(devClient); }
    if (pathname === '/exhibition-dashboard') { const role = identities[request.headers['x-meum-monitor-test-role']] ? request.headers['x-meum-monitor-test-role'] : 'excluded-creator'; response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>합성 설문 fixture</title></head><body><div id="app"></div><script type="module" src="/survey-fixture-entry-${role}.js"></script></body></html>`); }
    return next();
  } });
  try {
    await server.listen();
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const sourceProof = {};
    for (const id of sourceIds) {
      if (!BUSINESS_SOURCE_FILES[id]) throw new Error(`Survey source registry is missing ${id}`);
      sourceProof[id] = hash(await readFile(reviewedSourceFile(BUSINESS_SOURCE_FILES[id])));
    }
    const manifest = { schemaVersion: 1, kind: 'fixture', adapter: 'creator-voc-ui-memory-v1', environmentId: 'existing-creator-voc-ui-memory-qa', origin, serverGuardId: 'meum-memory-business-fixture-v1', productionForwarding: false, existingAccountsOnly: true, database: { mode: 'memory' }, dataset: { existing: true, roomId: 51, surveyId: 11, questionIds: [101, 102] }, roles: Object.fromEntries(Object.keys(identities).map(role => [role, `existing-fixture-${role}`])), sourceProof, scenarios: Object.fromEntries(scenarioIds.map(id => [id, { pagePath: '/exhibition-dashboard' }])) };
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
    const manifestSha256 = hash(bytes);
    marker = { environmentId: manifest.environmentId, manifestSha256, serverGuardId: manifest.serverGuardId, productionForwarding: false, mutationsRestrictedToDataset: true, existingAccountsOnly: true, dataset: manifest.dataset, roles: manifest.roles };
    const manifestPath = path.join(directory, 'survey-isolation.json');
    await writeFile(manifestPath, bytes);
    return { server, manifestPath, manifestSha256, scenarioIds, origin, counts: memory.counts, requestSummary: () => structuredClone(requests), sourceProof };
  } catch (error) { await server.close(); throw error; }
}
