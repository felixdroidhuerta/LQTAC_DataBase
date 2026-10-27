const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MySQLAdapter } = require('../src/adapters/mysql.cjs');
const { startMySQLFixture } = require('./mysql-fixture.cjs');

test('real MySQL wire handshake, metadata, SQL results, errors, limits and connection reuse', { timeout: 10000 }, async () => {
  const fixture = await startMySQLFixture();
  let adapter;
  try {
    adapter = await MySQLAdapter.open(fixture.profile, 'fixture-test-password');
    assert.deepEqual(fixture.handshakes[0], { user: 'fixture', database: 'test', hasToken: true });
    assert.deepEqual(await adapter.schema(), [{ name: 'proyectos', type: 'table' }, { name: 'vista', type: 'view' }]);
    const unicode = await adapter.execute('SELECT unicode');
    assert.deepEqual(unicode.results[0].values, [['Diseño LQTAC', null]]);
    const many = await adapter.execute('SELECT many');
    assert.equal(many.results[0].values.length, 1000);
    assert.equal(many.results[0].truncated, true);
    await assert.rejects(adapter.execute('SELECT broken'), /syntax error/);
    assert.equal((await adapter.execute('UPDATE fixture SET value=1')).changes, 2);
    assert.deepEqual((await adapter.execute('SELECT 1')).results[0].values, [['1']]);
    adapter.close();
    await assert.rejects(adapter.execute('SELECT 1'), /sesión está cerrada/);
  } finally { adapter?.close(); await fixture.close(); }
});
test('server authentication rejection produces an actionable error and closes its socket', { timeout: 10000 }, async () => {
  const fixture = await startMySQLFixture();
  try { await assert.rejects(MySQLAdapter.open({ ...fixture.profile, username: 'denied' }, 'fixture-test-password'), /Acceso denegado/); }
  finally { await fixture.close(); }
});
test('catalog lists all visible databases, empty schemas and unlimited metadata with routines', { timeout: 10000 }, async () => {
  const fixture = await startMySQLFixture();
  let adapter;
  try {
    adapter = await MySQLAdapter.open({ ...fixture.profile, database: '' }, 'fixture-test-password');
    const catalog = await adapter.catalog();
    assert.equal(catalog.database, '');
    assert.deepEqual(catalog.schemas.map(schema => schema.name), ['asterisk', 'test', 'sys']);
    assert.equal(catalog.schemas[0].objects.length, 1101);
    assert.equal(catalog.schemas[2].objects.length, 0);
    assert.deepEqual(catalog.schemas[1].objects.map(object => object.type), ['table', 'view', 'procedure', 'function']);
    await adapter.selectDatabase('asterisk');
    assert.equal(await adapter.currentDatabase(), 'asterisk');
    await adapter.selectDatabase('escaped`name');
    assert.equal(fixture.queries.at(-1), 'USE `escaped``name`');
  } finally { adapter?.close(); await fixture.close(); }
});
