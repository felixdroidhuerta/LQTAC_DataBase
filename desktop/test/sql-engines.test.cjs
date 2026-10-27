const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installDriverFixtures, startPostgresFixture } = require('./sql-engines-fixture.cjs');
const fixtures = installDriverFixtures();
const { PostgreSQLAdapter } = require('../src/adapters/postgresql.cjs');
const { SQLServerAdapter } = require('../src/adapters/sqlserver.cjs');
const { OracleAdapter, oracleStatement } = require('../src/adapters/oracle.cjs');
after(() => fixtures.restore());

test('PostgreSQL actual wire driver: schemas, rows, multiple results, DML counts, errors and search_path', async () => {
  const server = await startPostgresFixture(); let adapter;
  try {
    adapter = await PostgreSQLAdapter.open(server.profile, 'test-only');
    const catalog = await adapter.catalog(); assert.equal(catalog.database, 'public'); assert.equal(adapter.databaseName, 'lqtac'); assert.equal(catalog.schemas[0].objects[1].oid, '123');
    const result = await adapter.execute('SELECT 1 MULTI'); assert.equal(result.results.length, 2); assert.equal(result.results[1].values.length, 0); assert.equal(result.results[0].values[0][1], 'Ana');
    const large = (await adapter.execute('SELECT * FROM large')).results[0]; assert.equal(large.values.length, 1000); assert.equal(large.truncated, true);
    assert.equal((await adapter.execute('UPDATE clientes SET name=\'Test\'')).changes, 3);
    await assert.rejects(adapter.execute('SYNTAX_ERROR'), /syntax error/); assert.equal(adapter.alive, true);
    await adapter.selectDatabase('sales'); assert.equal(await adapter.currentDatabase(), 'sales');
    await adapter.selectDatabase('a"b'); assert.match(server.queries.at(-1), /"a""b"/);
  } finally { adapter?.close(); await server.close(); }
});

test('SQL Server adapter uses persistent TDS batches, metadata, TOP-compatible results, TLS and session changes', async () => {
  const profile = { host: 'localhost', port: 1433, username: 'sa', database: 'lqtac', tls: true };
  const adapter = await SQLServerAdapter.open(profile, 'test-only'); const connection = fixtures.sqlConnections.at(-1);
  try {
    assert.equal(connection.config.options.encrypt, true); assert.equal(connection.config.options.trustServerCertificate, false);
    assert.equal((await adapter.catalog()).schemas.length, 2); assert.equal(adapter.databaseName, 'lqtac');
    const result = await adapter.execute('SELECT TOP (100) * FROM dbo.clientes MULTI'); assert.equal(result.results.length, 2); assert.equal(result.results[0].values[0][1], 'Ana');
    const large = (await adapter.execute('SELECT * FROM large')).results[0]; assert.equal(large.values.length, 1000); assert.equal(large.truncated, true);
    assert.equal((await adapter.execute('UPDATE dbo.clientes SET nombre=\'Test\'')).changes, 1);
    await adapter.execute('USE [other]'); assert.equal(adapter.catalogDirty, true); await adapter.catalog(); assert.equal(adapter.databaseName, 'other'); assert.equal(adapter.catalogDirty, false);
    await assert.rejects(adapter.execute('SYNTAX_ERROR'), /Incorrect syntax/); assert.equal(adapter.alive, true);
  } finally { adapter.close(); }
  assert.equal(connection.closed, true);
  await assert.rejects(SQLServerAdapter.open(profile, 'bad'), /Login failed/); assert.equal(fixtures.sqlConnections.at(-1).closed, true);
});

test('Oracle Thin adapter: service/TLS config, schema, resultset cleanup, DML without autocommit, COMMIT and SQL errors', async () => {
  const profile = { host: 'localhost', port: 1521, username: 'HR', database: 'FREEPDB1', tls: true };
  const adapter = await OracleAdapter.open(profile, 'test-only'); const connection = fixtures.oracleConnections.at(-1);
  try {
    assert.match(connection.config.connectString, /^tcps:\/\/localhost:1521\/FREEPDB1\?/); assert.equal(connection.config.sslServerDNMatch, true); assert.equal(connection.callTimeout, 30000);
    assert.equal((await adapter.catalog()).schemas[0].name, 'HR');
    const result = await adapter.execute('SELECT * FROM "HR"."CLIENTES"; -- trailing comment'); assert.equal(result.results[0].values[0][1], 'Ana'); assert.equal(connection.closedSets, 1); assert.doesNotMatch(connection.queries.at(-1).sql, /; --/);
    const large = (await adapter.execute('SELECT * FROM large;')).results[0]; assert.equal(large.values.length, 1000); assert.equal(large.truncated, true); assert.equal(connection.closedSets, 2);
    await adapter.execute('UPDATE CLIENTES SET NAME=\'Test\';'); assert.equal(connection.pendingWrites, 1); assert.equal(connection.queries.at(-1).options.autoCommit, false);
    await adapter.execute('COMMIT;'); assert.equal(connection.committed, true);
    await adapter.selectDatabase('SALES'); assert.equal(await adapter.currentDatabase(), 'SALES');
    await assert.rejects(adapter.execute('SYNTAX_ERROR;'), /ORA-00900/);
  } finally { adapter.close(); }
  assert.equal(connection.closed, true);
  await assert.rejects(OracleAdapter.open({ ...profile, database: '' }, ''), /servicio válido/);
  await assert.rejects(OracleAdapter.open(profile, 'bad'), /ORA-01017/);
});

test('Oracle terminators retain PL/SQL blocks, quoted semicolons and comments; dialects generate safe native queries/completions', async () => {
  assert.equal(oracleStatement("SELECT ';' FROM DUAL;"), "SELECT ';' FROM DUAL");
  assert.equal(oracleStatement('BEGIN NULL; END;\n/'), 'BEGIN NULL; END;');
  assert.equal(oracleStatement('-- intro\nCREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;'), '-- intro\nCREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;');
  const { objectQuery } = await import('../src/renderer/explorer.js'); const { getTableCompletions } = await import('../src/renderer/autocomplete.js'); const { tokenizeSQL } = await import('../src/renderer/sql-highlight.js');
  for (const [engine, schema, name, pattern] of [['postgresql', 'public', 'a"b', /"public"\."a""b" LIMIT/], ['sqlserver', 'dbo', 'a]b', /TOP \(100\).*\[dbo\]\.\[a\]\]b\]/], ['oracle', 'HR', 'A"B', /FETCH FIRST 100 ROWS ONLY/]]) {
    assert.match(objectQuery(schema, { name, type: 'table' }, engine), pattern);
    const connection = { engine, database: schema, schemas: [{ name: schema, objects: [{ name, type: 'table' }] }] };
    const completion = getTableCompletions('SELECT * FROM ', 14, connection)[0]; assert.ok(completion.insert.includes(engine === 'sqlserver' ? ']]' : '""'));
    const source = objectQuery(schema, { name, type: 'table' }, engine); assert.equal(tokenizeSQL(source, { dialect: engine }).map(token => token.text).join(''), source);
  }
  assert.match(objectQuery('public', { name: 'calc', type: 'function', oid: '123' }, 'postgresql'), /pg_get_functiondef\(123::oid\)/);
  assert.match(objectQuery('dbo', { name: "p'roc", type: 'procedure' }, 'sqlserver'), /OBJECT_DEFINITION.*p''roc/);
  assert.match(objectQuery('HR', { name: 'CALC', type: 'function' }, 'oracle'), /ALL_SOURCE.*TYPE='FUNCTION'/);
  assert.equal(getTableCompletions('SELECT $$ FROM cli', 18, { engine: 'postgresql', schemas: [{ name: 'public', objects: [] }] }).length, 0);
  const bracket = getTableCompletions('SELECT * FROM [cl', 17, { engine: 'sqlserver', database: 'dbo', schemas: [{ name: 'dbo', objects: [{ name: 'clientes', type: 'table' }] }] })[0]; assert.equal(bracket.insert, '[clientes]');
});
