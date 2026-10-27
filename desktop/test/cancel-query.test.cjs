const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { executeTimed } = require('../src/settings.cjs');
const { startMySQLFixture } = require('./mysql-fixture.cjs');
const { installDriverFixtures, startPostgresFixture } = require('./sql-engines-fixture.cjs');
const { startClickHouseFixture, startMongoFixture } = require('./extra-engines-fixture.cjs');
const fixtures = installDriverFixtures(); after(() => fixtures.restore());
const { MySQLAdapter } = require('../src/adapters/mysql.cjs');
const { PostgreSQLAdapter } = require('../src/adapters/postgresql.cjs');
const { SQLServerAdapter } = require('../src/adapters/sqlserver.cjs');
const { OracleAdapter } = require('../src/adapters/oracle.cjs');
const { ClickHouseAdapter } = require('../src/adapters/clickhouse.cjs');
const { MongoDBAdapter } = require('../src/adapters/mongodb.cjs');

for (const [engine, Driver, startFixture, sql] of [
  ['mysql', MySQLAdapter, startMySQLFixture, 'SELECT wait_forever'],
  ['postgresql', PostgreSQLAdapter, startPostgresFixture, 'SELECT wait_forever'],
  ['clickhouse', ClickHouseAdapter, startClickHouseFixture, 'SELECT wait_forever'],
  ['mongodb', MongoDBAdapter, startMongoFixture, '{"find":"wait_forever"}']
]) test(`${engine}: deadline cancels only the active query through a control channel, preserving the working session`, async () => {
  const server = await startFixture(); const adapter = await Driver.open(server.profile, 'fixture');
  const working = adapter.connection || adapter.client;
  try {
    await assert.rejects(executeTimed(adapter, engine, sql, 100, { openControl: () => Driver.open(server.profile, 'fixture') }), {message:'Agotado tiempo máximo de consulta'});
    await adapter.pendingExecution?.done;
    assert.equal(adapter.alive, true); if (engine !== 'clickhouse') assert.equal(adapter.connection || adapter.client, working);
    const result = await executeTimed(adapter, engine, engine === 'mongodb' ? '{"find":"clientes"}' : 'SELECT 1', 1000);
    assert.ok(result.results[0].values.length > 0);
  } finally { adapter.close(); await server.close(); }
});
test('SQL Server ATTENTION and Oracle break cancel a query without discarding their physical session', async () => {
  for (const [engine, Driver, profile, sql] of [
    ['sqlserver', SQLServerAdapter, { host: 'localhost', port: 1433, username: 'sa', database: 'test' }, 'SELECT wait_forever'],
    ['oracle', OracleAdapter, { host: 'localhost', port: 1521, username: 'HR', database: 'FREEPDB1' }, 'SELECT wait_forever FROM DUAL']
  ]) {
    const adapter = await Driver.open(profile, 'fixture'); const physical = adapter.connection;
    try {
      await assert.rejects(executeTimed(adapter, engine, sql, 20), {message:'Agotado tiempo máximo de consulta'});
      await adapter.pendingExecution?.done;
      assert.equal(adapter.alive, true); assert.equal(adapter.connection, physical);
      assert.ok((await adapter.execute(engine === 'oracle' ? 'SELECT 1 FROM DUAL' : 'SELECT 1')).results[0].values.length);
    } finally { adapter.close(); }
  }
});
test('cancellation drains its acknowledgement before releasing the session; repeated stop and late stop are harmless', async () => {
  let rejectQuery, acknowledge, cancels = 0, returned = false;
  const controller = new AbortController();
  const adapter = { alive: true, execute() { return new Promise((_, reject) => { rejectQuery = reject; }); }, cancelQuery() { cancels++; rejectQuery(new Error('interrupted')); return new Promise(resolve => { acknowledge = resolve; }); }, close() { throw new Error('Must preserve this session'); } };
  const operation = executeTimed(adapter, 'mysql', 'UPDATE x', 1000, { signal: controller.signal }).catch(error => { returned = true; return error; });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); controller.abort();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(returned, true); const reservation=adapter.pendingExecution; assert.ok(reservation);
  await assert.rejects(executeTimed(adapter,'mysql','SELECT next',1000), /consulta anterior/);
  acknowledge(); await reservation.done; assert.equal(adapter.pendingExecution,undefined);
  assert.match((await operation).message, /cancelada por el usuario/); assert.equal(adapter.alive, true); assert.equal(cancels, 1);
  const completed = new AbortController(); const fast = { alive: true, execute: async () => 42, cancelQuery() { throw new Error('Late stop must not run'); } };
  assert.equal(await executeTimed(fast, 'mysql', 'SELECT 1', 1000, { signal: completed.signal }), 42); completed.abort();
});
test('a rejected timeout cancellation can be retried with Stop without disconnecting or re-executing SQL', async () => {
  const server = await startMySQLFixture({ denyCancel: true }); const adapter = await MySQLAdapter.open(server.profile, 'fixture');
  try {
    const original = adapter.connection;
    await assert.rejects(executeTimed(adapter, 'mysql', 'SELECT wait_forever', 20, { openControl: () => MySQLAdapter.open(server.profile, 'fixture') }), {message:'Agotado tiempo máximo de consulta'});
    const pending=adapter.pendingExecution; for(let i=0;i<100&&!pending.controlError;i++)await new Promise(resolve=>setTimeout(resolve,10)); assert.ok(pending.controlError);
    assert.equal(adapter.alive, true); assert.equal(adapter.connection, original);
    server.allowCancellation(); pending.cancel(); await pending.done;
    assert.equal(adapter.alive, true); assert.equal(server.queries.filter(sql => sql === 'SELECT wait_forever').length, 1);
    assert.ok((await adapter.execute('SELECT 1')).results[0].values.length);
  } finally { adapter.close(); await server.close(); }
});
test('Stop remains retryable after an earlier manual cancellation failed', async () => {
  const server = await startMySQLFixture({ denyCancel: true }); const adapter = await MySQLAdapter.open(server.profile, 'fixture');
  try {
    const controller = new AbortController();
    const operation = executeTimed(adapter, 'mysql', 'SELECT wait_forever', 1000, { signal: controller.signal, openControl: () => MySQLAdapter.open(server.profile, 'fixture') });
    await new Promise(resolve => setTimeout(resolve, 30)); controller.abort(); await assert.rejects(operation, /cancelada por el usuario/);
    const pending=adapter.pendingExecution; for(let i=0;i<100&&!pending.controlError;i++)await new Promise(resolve=>setTimeout(resolve,10)); assert.ok(pending.controlError);
    assert.equal(adapter.alive, true); server.allowCancellation(); pending.cancel(); await pending.done; assert.equal(adapter.alive, true);
  } finally { adapter.close(); await server.close(); }
});
test('PostgreSQL permits an explicit ROLLBACK after cancellation without metadata or SET blocking recovery', async () => {
  let aborted = false; const sent = [];
  const client = { on() {}, query(query) {
    if (typeof query === 'string') {
      sent.push(query);
      if (aborted) return Promise.reject(Object.assign(new Error('current transaction is aborted'), { code: '25P02' }));
      return Promise.resolve({ rows: [{ current_schema: 'public', current_database: 'test' }] });
    }
    sent.push(query.text); assert.equal(query.text, 'ROLLBACK'); aborted = false;
    queueMicrotask(() => query.emit('end', { command: 'ROLLBACK', fields: [], rowCount: null }));
  } };
  const adapter = new PostgreSQLAdapter(client);
  assert.equal(await adapter.currentDatabase(), 'public'); aborted = true;
  assert.equal(await adapter.currentDatabase(), 'public'); assert.equal(adapter.transactionAborted, true);
  await adapter.execute('ROLLBACK', { managed: true });
  assert.equal(adapter.transactionAborted, false); assert.equal(adapter.alive, true); assert.equal(sent.at(-1), 'ROLLBACK'); assert.equal(sent.some(sql => sql.startsWith('SET')), false);
});
test('a silent server cannot hold the timeout response or block other sessions; only its own session stays reserved', async () => {
  let finish; let calls=0;
  const adapter={alive:true,execute(){calls++;return new Promise((_,reject)=>{finish=reject;});},cancelQuery:async()=>{},close(){throw new Error('Do not disconnect on timeout');}};
  const started=Date.now();
  await assert.rejects(executeTimed(adapter,'mysql','SELECT stuck',20),{message:'Agotado tiempo máximo de consulta'});
  assert.ok(Date.now()-started<300);const pending=adapter.pendingExecution;assert.ok(pending);assert.equal(adapter.alive,true);
  await assert.rejects(executeTimed(adapter,'mysql','SELECT must_not_queue',20),/consulta anterior/);assert.equal(calls,1);
  assert.equal(await executeTimed({execute:async()=>42},'mysql','SELECT other',100),42);
  finish(new Error('Cancellation confirmed later'));await pending.done;assert.equal(adapter.pendingExecution,undefined);
});
