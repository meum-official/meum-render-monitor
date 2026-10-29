// Actual component logic only: no Vue app, credentials, backend, or customer data are loaded.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export async function checkReadonlyComponentFixture() {
  const source = await readFile(path.join(workspace, '8302_adminMeum-master/src/components/exhibition/experience/ExhibitionExperience.vue'), 'utf8');
  const script = source.split('<script setup>')[1]?.split('</script>')[0];
  assert.ok(script, 'actual script setup is required');
  const require = createRequire(path.join(workspace, '8080_meum-backend-api-develop/meum-backend-api-develop/package.json'));
  const ast = require('@babel/parser').parse(script, { sourceType: 'module' });
  const save = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'onClickSave');
  assert.ok(save);
  const condition = source.match(/const canSave = computed\(([^;]+)\);/)?.[1];
  assert.ok(condition);
  const canSave = role => vm.runInNewContext(`(${condition})()`, { store: { state: { userInfo: { is_auth: role } } } });
  assert.equal(canSave(0), true); assert.equal(canSave(1), true); assert.equal(canSave(2), false);
  let writes = 0;
  const prohibited = () => { writes++; throw Error('unexpected fixture write'); };
  const context = {
    canSave: { value: false }, isSaving: { value: false }, hasChanges: { value: true }, commentLoaded: { value: true },
    roomId: { value: 991001 }, axios: { patch: prohibited, put: prohibited, post: prohibited },
  };
  const action = vm.runInNewContext(`(${script.slice(save.start, save.end)})`, context);
  await action();
  assert.equal(writes, 0);
  assert.ok((source.match(/:disabled="[^"]*!canSave[^"]*"/g) || []).length >= 2);
  return { status: 'pass', evidenceScope: 'fixture', fixtureType: 'actual-component-logic-only', sourceSha256: createHash('sha256').update(source).digest('hex'), checks: ['owner and invited-admin component permissions retained', 'read-only component permission false', 'actual save function makes zero writes when read-only', 'template save/toggles bind canSave'], productionMutations: 0, databaseConnections: 0, limits: ['Not a rendered UI or real server403 test. Full readonly adapter remains unvalidated; actual-app business remains blocked.'] };
}
