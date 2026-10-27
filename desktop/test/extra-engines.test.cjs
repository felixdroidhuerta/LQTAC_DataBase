const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ClickHouseAdapter } = require('../src/adapters/clickhouse.cjs');
const { MongoDBAdapter, parseCommand } = require('../src/adapters/mongodb.cjs');
const { validateProfile } = require('../src/connections.cjs');
const { startClickHouseFixture, startMongoFixture } = require('./extra-engines-fixture.cjs');

test('ClickHouse HTTP driver handles catalog, qualified SQL, output limits, DDL, errors and changing databases', async () => {
  const fixture = await startClickHouseFixture(); let adapter;
  try {
    assert.equal(validateProfile(fixture.profile).engine, 'clickhouse');
    adapter = await ClickHouseAdapter.open(fixture.profile, 'fixture-only');
    const catalog = await adapter.catalog();
    assert.equal(catalog.database, 'default'); assert.equal(catalog.schemas[1].objects[0].type, 'view');
    const output = await adapter.execute('SELECT * FROM events;');
    assert.deepEqual(output.results[0].columns, ['id', 'payload']); assert.equal(output.results[0].values[0][1], '{"nested":"valor"}');
    assert.equal(fixture.queries.at(-1).headers['x-clickhouse-format'], 'JSONCompact');
    const large = (await adapter.execute('SELECT * FROM large')).results[0]; assert.equal(large.values.length, 1000); assert.equal(large.truncated, true);
    assert.equal((await adapter.execute('CREATE TABLE demo (id UInt8) ENGINE=Memory')).results.length, 0);
    await assert.rejects(adapter.execute('SYNTAX_ERROR'), /Syntax error/);
    await adapter.selectDatabase('analytics'); assert.equal(await adapter.currentDatabase(), 'analytics');
    await adapter.execute('SELECT 1'); assert.equal(fixture.queries.at(-1).database, 'analytics');
    await assert.rejects(adapter.selectDatabase('missing')); assert.equal(await adapter.currentDatabase(), 'analytics');
    await adapter.execute('USE `default`;'); assert.equal(await adapter.currentDatabase(), 'default');
  } finally { adapter?.close(); await fixture.close(); }
});

test('MongoDB actual driver handshake, catalogs, cursors, Extended JSON, writes and errors against protocol fixture', async () => {
  const fixture = await startMongoFixture(); let adapter;
  try {
    assert.equal(validateProfile({ ...fixture.profile, authSource: 'admin', password: 'never-save' }).authSource, 'admin');
    assert.equal(Object.hasOwn(validateProfile({ ...fixture.profile, password: 'never-save' }), 'password'), false);
    adapter = await MongoDBAdapter.open(fixture.profile, '');
    const catalog = await adapter.catalog(); assert.equal(catalog.schemas.length, 2); assert.equal(catalog.schemas[0].objects[0].type, 'collection');
    const result = (await adapter.execute('{"find":"clientes","filter":{},"limit":100}')).results[0];
    assert.deepEqual(result.columns, ['_id', 'name', 'score', 'extra']); assert.match(result.values[0][0], /\$oid/); assert.equal(result.values[1][0], null);
    await adapter.execute('{"find":"clientes","$db":"other"}'); assert.equal(fixture.commands.at(-1).$db, 'other');
    assert.equal(await adapter.currentDatabase(), 'test');
    await adapter.selectDatabase('other'); assert.equal(await adapter.currentDatabase(), 'other');
    const large = (await adapter.execute('{"find":"large"}')).results[0]; assert.equal(large.values.length, 1000); assert.equal(large.truncated, true);
    assert.equal(fixture.commands.some(command => command.killCursors), true);
    assert.equal((await adapter.execute('{"insert":"clientes","documents":[{"name":"Test"}]}')).changes, 1);
    await adapter.execute('{"aggregate":"clientes","pipeline":[]}'); assert.deepEqual(fixture.commands.at(-1).cursor, {});
    await assert.rejects(adapter.execute('{"badCommand":1}'), /No such command/);
    await assert.rejects(adapter.execute('db.clientes.find({})'), /JSON/);
    await assert.rejects(adapter.execute('{"$db":"bad.name","find":"clientes"}'), /base válida/);
    assert.throws(() => parseCommand('[]'), /objeto JSON/);
    assert.equal(parseCommand('{"find":"clientes","filter":{"_id":{"$oid":"000000000000000000000001"}}}').filter._id.toHexString(), '000000000000000000000001');
  } finally { adapter?.close(); await fixture.close(); }
});

test('MongoDB explorer queries, completions and colors use JSON without transforming source', async () => {
  const { objectQuery } = await import('../src/renderer/explorer.js');
  const { getTableCompletions } = await import('../src/renderer/autocomplete.js');
  const { tokenizeSQL } = await import('../src/renderer/sql-highlight.js');
  const source = objectQuery('other', { name: 'cli"entes', type: 'collection' }, 'mongodb');
  assert.deepEqual(JSON.parse(source), { find: 'cli"entes', filter: {}, limit: 100, $db: 'other' });
  const command = '{"find":"cl","filter":{}}'; const cursor = command.indexOf('cl') + 2;
  const connection = { engine: 'mongodb', database: 'test', schemas: [{ name: 'test', objects: [{ name: 'clientes', type: 'collection' }] }] };
  const item = getTableCompletions(command, cursor, connection)[0];
  assert.equal(JSON.parse(command.slice(0, item.from) + item.insert + command.slice(item.to)).find, 'clientes');
  connection.schemas.push({ name: 'other', objects: [{ name: 'claves', type: 'collection' }] });
  assert.equal(getTableCompletions('{"find":"cl","$db":"other"}', cursor, connection)[0].name, 'claves');
  assert.deepEqual(getTableCompletions('{"filter":{"name":"cl', 21, connection), []);
  const tokens = tokenizeSQL(source, { dialect: 'mongodb' }); assert.equal(tokens.map(token => token.text).join(''), source);
  assert.equal(tokens.some(token => token.type === 'identifier' && token.text === '"find"'), true);
});
