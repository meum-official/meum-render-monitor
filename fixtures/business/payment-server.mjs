// Reuse the existing actual-component QA server; every payment/DB operation stays in its memory fixture.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { BUSINESS_SOURCE_FILES } from '../../business-contracts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const hash = value => createHash('sha256').update(value).digest('hex');

export async function createPaymentBusinessFixture(directory) {
  const { createTrialUpgradeQaServer } = await import(pathToFileURL(path.join(root, '8301_front-end/scripts/test-trial-upgrade-ui.mjs')).href);
  // Its existing CSP embeds the configured port, so choose a free port before constructing Vite.
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const server = await createTrialUpgradeQaServer({ port, selfTest: true });
  // Vite's transformed SFCs still import its hot context with hmr:false. Replace only the fixture
  // dev transport, preserving CSS insertion, so no WebSocket needs to be permitted by the guard.
  const noNetworkDevClient = `
const styles=new Map();
export const createHotContext=()=>({data:{},accept(){},acceptExports(){},dispose(){},prune(){},on(){},off(){},send(){},invalidate(){}});
export function updateStyle(id,content){let node=styles.get(id);if(!node){node=document.createElement('style');node.dataset.fixtureStyle=id;styles.set(id,node);document.head.appendChild(node);}node.textContent=content;}
export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}
export const injectQuery=(url,query)=>url+(url.includes('?')?'&':'?')+query;
`;
  server.middlewares.stack.unshift({ route: '', handle(request, response, next) {
    if (new URL(request.url, 'http://127.0.0.1').pathname !== '/@vite/client') return next();
    response.setHeader('Content-Type', 'text/javascript');
    response.setHeader('Cache-Control', 'no-store');
    response.end(noNetworkDevClient);
  } });
  let marker;
  server.middlewares.use((request, response, next) => {
    if (new URL(request.url, 'http://127.0.0.1').pathname !== '/.well-known/meum-monitor-isolation') return next();
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify(marker));
  });
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const sourceProof = {};
    for (const id of ['payment-component-server', 'payment-component-fixtures', 'payment-component', 'business-payment-server']) sourceProof[id] = hash(await readFile(path.join(root, BUSINESS_SOURCE_FILES[id])));
    const manifest = {
      schemaVersion: 1, kind: 'fixture', adapter: 'trial-upgrade-component-v1', environmentId: 'existing-trial-upgrade-component-memory-qa',
      origin, serverGuardId: 'meum-memory-business-fixture-v1', productionForwarding: false, existingAccountsOnly: true,
      database: { mode: 'memory' }, dataset: { accountId: 'fixture', existing: true }, roles: { payer: 'fixture' },
      mockPayment: { enabled: true, networkDisabled: true }, sourceProof,
      scenarios: Object.fromEntries(['payment-success-immediate', 'payment-success-scheduled', 'payment-failure-cancel', 'payment-duplicate-callback'].map(id => [id, { pagePath: '/plan?plan=project_3month' }])),
    };
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
    const manifestSha256 = hash(bytes);
    marker = { environmentId: manifest.environmentId, manifestSha256, serverGuardId: manifest.serverGuardId, productionForwarding: false, mutationsRestrictedToDataset: true, existingAccountsOnly: true, dataset: manifest.dataset, roles: manifest.roles, mockPaymentNetworkDisabled: true };
    await mkdir(directory, { recursive: true });
    const manifestPath = path.join(directory, 'payment-component-isolation.json');
    await writeFile(manifestPath, bytes);
    return { server, manifestPath, manifestSha256, scenarioIds: Object.keys(manifest.scenarios), origin };
  } catch (error) { await server.close(); throw error; }
}
