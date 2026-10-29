// Compile only the current auto-install method and DTO helpers; never import the app, DB models, config, or env.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const backend = path.join(workspace, '8080_meum-backend-api-develop/meum-backend-api-develop');
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
export const AUTO_INSTALL_MEMORY_SOURCE_FILES = {
  'auto-install-method': '8080_meum-backend-api-develop/meum-backend-api-develop/services/roomService.js',
  'auto-install-memory-fixture': 'tools/meum-render-monitor/fixtures/business/auto-install.mjs',
  'auto-install-template': '8080_meum-backend-api-develop/meum-backend-api-develop/services/auto-install/land_10.json',
  'auto-install-startpoints': '8080_meum-backend-api-develop/meum-backend-api-develop/services/auto-install/start-points.json',
  'auto-install-autoplay': '8080_meum-backend-api-develop/meum-backend-api-develop/services/auto-play/land_10.json',
  'auto-install-gallery-helper': '8080_meum-backend-api-develop/meum-backend-api-develop/utils/galleryDecoration.js',
};

export async function createCurrentAutoInstallMemoryFixture() {
  const require = createRequire(path.join(backend, 'package.json'));
  const { parse } = require('@babel/parser');
  const source = await readFile(path.join(backend, 'services/roomService.js'), 'utf8');
  const ast = parse(source, { sourceType: 'unambiguous' });
  let method;
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ObjectMethod' && node.key?.name === 'autoItemInstallLatestDto') method = node;
    for (const value of Object.values(node)) if (value && typeof value === 'object') Array.isArray(value) ? value.forEach(visit) : visit(value);
  };
  visit(ast.program);
  assert.ok(method, 'current actual auto-install method must exist');
  const requiredHelpers = new Set(['OBJECT_TYPE_PREFIX_MAP', 'LATEST_ARTWORK_REQUIRED_FIELDS', 'getObjectTypePrefix', 'makeLatestAssetId', 'normalizeLatestArtworkPk', 'createLatestArtworkDto', 'ensureLatestArtworkRequiredFields']);
  const declarations = ast.program.body.filter(node =>
    node.type === 'FunctionDeclaration' && requiredHelpers.has(node.id?.name) ||
    node.type === 'VariableDeclaration' && node.declarations.some(value => requiredHelpers.has(value.id?.name))
  ).map(node => source.slice(node.start, node.end));
  // Include the exact established DTO helper region, which contains declarations only.
  const helperBegin = source.indexOf('const OBJECT_TYPE_PREFIX_MAP');
  const helperEnd = source.indexOf('function convertMarkdownToTmpRichText');
  assert.ok(helperBegin >= 0 && helperEnd > helperBegin);
  assert.ok(declarations.length >= 4);
  const helperSource = source.slice(helperBegin, helperEnd);
  assert.doesNotMatch(helperSource, /require\s*\(|process\.env|DB\./);
  const functionSource = name => {
    const node = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id?.name === name);
    assert.ok(node, `actual ${name} must exist`);
    return source.slice(node.start, node.end);
  };
  const startPoints = JSON.parse(await readFile(path.join(backend, 'services/auto-install/start-points.json'), 'utf8'));
  const autoPlay = JSON.parse(await readFile(path.join(backend, 'services/auto-play/land_10.json'), 'utf8'));
  const helpers = vm.runInNewContext(`${helperSource}\n${functionSource('convertMarkdownToTmpRichText')}\n${functionSource('cloneDefaultAutoPlayDataByLand')}\n({createLatestArtworkDto,toUnclickable,convertMarkdownToTmpRichText,cloneDefaultAutoPlayDataByLand});`, { uuidv4: randomUUID, defaultAutoPlayDataByLand: { 10: autoPlay } });
  const templateBytes = await readFile(path.join(backend, 'services/auto-install/land_10.json'));
  const template = JSON.parse(templateBytes);
  const roomId = 991001;
  const before = { id: roomId, owner_id: 991100, land_type: 10, detail: { title: 'Isolated auto-install title', content: 'Isolated auto-install description' }, data_json: '{"artworks":[]}', startPoint_json: '{}', thumbnail_url: 'https://graphic-box.s3.fixture.invalid/thumbnail.png' };
  let saves = 0, transactions = 0;
  const locked = { ...structuredClone(before), async save() { saves++; } };
  const items = [0, 2].map((object_type_id, i) => ({ id: 991002 + i, room_id: roomId, object_type_id, image_file: `fixture-only-${i}`, size_w: 150, size_h: 70, is_clickable: 0, autoplay: 0, loop: 0 }));
  const DB = {
    api_item: { async findAll({ where }) { assert.equal(where.room_id, roomId); assert.equal(JSON.stringify(where.id), JSON.stringify(items.map(item => item.id))); return clone(items); } },
    api_room: { async findByPk(id, { transaction, lock }) { assert.equal(id, roomId); assert.equal(lock, transaction.LOCK.UPDATE); return locked; } },
    sequelize: { async transaction(callback) { transactions++; return callback({ LOCK: { UPDATE: 'FIXTURE_UPDATE' } }); } },
  };
  const { preserveGalleryForSave } = require(path.join(backend, 'utils/galleryDecoration.js'));
  const errors = [];
  const executable = source.slice(method.start, method.end).replace(/^async\s+autoItemInstallLatestDto\(/, 'async function autoItemInstallLatestDto(');
  const run = vm.runInNewContext(`(${executable})`, {
    DB, path, __dirname: '/fixture-only', fs: { async readFile(filename) { assert.equal(path.basename(filename), 'land_10.json'); return templateBytes.toString('utf8'); } },
    itemService: { async findPosterByRoomId() { return { id: 991004, image_file: 'fixture-poster' }; } },
    probe: async value => { assert.equal(value, 'fixture-poster'); return { width: 1000, height: 1500 }; }, startPoints,
    preserveGalleryForSave, ...helpers,
    console: { log() {}, warn() {}, error(error) { errors.push(error.message); } },
  });
  const sourceProof = {};
  for (const [id, relative] of Object.entries(AUTO_INSTALL_MEMORY_SOURCE_FILES)) sourceProof[id] = hash(await readFile(path.join(workspace, relative)));
  return {
    dataset: { roomId, landId: 10, itemIds: items.map(item => item.id), expectedStartPoint: clone(startPoints[10]), existing: true },
    before: clone(before), items: clone(items), template: clone(template), sourceProof,
    read: () => clone(locked),
    stats: () => ({ saves, transactions, errors: [...errors], databaseConnections: 0, productionMutations: 0, accountsCreated: 0 }),
    async install(body) {
      assert.equal(body.landId, 10);
      assert.equal(JSON.stringify(body.itemIds), JSON.stringify(items.map(item => item.id)));
      return clone(await run.call({ findRoomById: async id => { assert.equal(id, roomId); return clone(locked); } }, roomId, 10, body.itemIds));
    },
  };
}

export async function checkCurrentAutoInstallFixture() {
  const fixture = await createCurrentAutoInstallMemoryFixture();
  const { roomId, itemIds } = fixture.dataset;
  const before = fixture.before;
  const signature = data => data.artworks.map(item => [item.object_type_id, item.artwork_pk, item.position, item.eulerAngle, item.scale]);
  const first = await fixture.install({ landId: 10, itemIds });
  assert.equal(first.success, true, fixture.stats().errors.join('; '));
  const firstData = JSON.parse(fixture.read().data_json);
  const firstSignature = signature(firstData);
  const second = await fixture.install({ landId: 10, itemIds });
  assert.equal(second.success, true, fixture.stats().errors.join('; '));
  const after = JSON.parse(fixture.read().data_json);
  assert.deepEqual(signature(after), firstSignature, 'same selection must not append duplicate placements or move existing slots');
  assert.deepEqual(after.artworks.filter(item => [0, 2].includes(item.object_type_id)).map(item => item.artwork_pk), [991002, 991003]);
  assert.equal(new Set(after.artworks.map(item => item.assetId)).size, after.artworks.length);
  for (const item of after.artworks) for (const key of ['position', 'eulerAngle', 'scale']) if (item[key]) assert.ok(['x', 'y', 'z'].every(axis => Number.isFinite(item[key][axis])), `finite ${key}`);
  assert.equal(after.artworks.find(item => item.object_type_id === 6)?.text, before.detail.title);
  assert.deepEqual(fixture.read().detail, before.detail);
  assert.deepEqual(JSON.parse(fixture.read().startPoint_json), fixture.dataset.expectedStartPoint);
  assert.equal(fixture.stats().saves, 2); assert.equal(fixture.stats().transactions, 2);
  return { status: 'pass', evidenceScope: 'fixture', sourceSha256: fixture.sourceProof['auto-install-method'], templateSha256: fixture.sourceProof['auto-install-template'], checks: ['current actual method compiled by AST range', 'synthetic selected image/video IDs retained', 'finite transforms', 'no duplicate placements on repeated install', 'actual land10 start point', 'title/description originals preserved', 'row lock and transaction used for both saves'], writes: { memorySaves: 2, databaseConnections: 0, productionMutations: 0, accountsCreated: 0 }, limits: ['Method fixture only; real HTTP role authorization, MySQL transaction semantics and full Unity rendering are not established.'] };
}
