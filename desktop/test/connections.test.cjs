const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ConnectionStore, validateProfile } = require('../src/connections.cjs');
const profile = { name: 'Desarrollo', engine: 'postgresql', host: 'localhost', port: '5432', database: 'lqtac', username: 'felix' };

test('profiles round trip, update without duplicates, serialize saves and discard unexpected secrets', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lqtac-profiles-'));
  try {
    const store = new ConnectionStore(directory);
    assert.deepEqual(await store.list(), []);
    const saved = await store.save({ ...profile, password: 'test-secret' });
    const updated = await store.save({ ...saved, name: 'Desarrollo actualizado' });
    assert.equal(updated.id, saved.id);
    assert.equal((await store.list()).length, 1);
    await Promise.all([store.save({ ...profile, name: 'Servidor 2' }), store.save({ ...profile, name: 'Servidor 3' })]);
    const reloaded = await new ConnectionStore(directory).list();
    assert.equal(reloaded.length, 3);
    assert.equal(reloaded[0].name, 'Desarrollo actualizado');
    assert.equal((await fs.readFile(store.file, 'utf8')).includes('test-secret'), false);
    assert.equal(reloaded[0].port, 5432);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('reject invalid engines, hosts and ports before storing profiles', () => {
  for (const port of [0, -1, 65536, 1.5, 'invalid', '']) assert.throws(() => validateProfile({ ...profile, port }), /puerto/);
  assert.throws(() => validateProfile({ ...profile, host: '  ' }), /host/);
  assert.throws(() => validateProfile({ ...profile, engine: 'unknown' }), /motor/);
});
test('a connection may omit its default database, as in Workbench', () => {
  assert.equal(validateProfile({ ...profile, database: '' }).database, '');
  const { database, ...withoutDatabase } = profile;
  assert.equal(validateProfile(withoutDatabase).database, '');
});
test('groups persist, move members uniquely, ungroup without deleting profiles and archive removed profiles', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lqtac-groups-'));
  try {
    const store = new ConnectionStore(directory);
    const a = await store.save({ ...profile, name: 'Servidor A', password: 'never-store' });
    const b = await store.save({ ...profile, name: 'Servidor B' });
    const c = await store.save({ ...profile, name: 'Servidor C' });
    assert.deepEqual(await store.groups(), []);
    const first = await store.createGroup('Producción', [a.id, b.id]);
    const second = await store.createGroup('Pruebas', [c.id]);
    await store.move([a.id], second.id);
    assert.deepEqual((await store.groups())[0].connectionIds, [b.id]);
    assert.deepEqual((await new ConnectionStore(directory).groups())[1].connectionIds, [c.id, a.id]);
    await store.move([a.id, c.id], null);
    assert.deepEqual((await store.groups())[1].connectionIds, []);
    await assert.rejects(store.move([b.id], 'invalid-group'), /grupo/);
    await assert.rejects(store.createGroup('Producción', [a.id]), /existe/);
    await assert.rejects(store.move(['missing-profile'], first.id), /existe/);
    await store.remove([b.id]);
    assert.equal((await store.list()).length, 2);
    assert.deepEqual((await store.groups())[0].connectionIds, []);
    const archive = await fs.readFile(store.trashFile, 'utf8');
    assert.equal(archive.includes('never-store'), false);
    assert.equal(JSON.parse(archive)[0].id, b.id);
    await store.ungroup(first.id);
    assert.equal((await store.groups()).length, 1);
    assert.equal((await store.list()).length, 2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
