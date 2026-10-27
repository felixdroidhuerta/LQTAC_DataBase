const { EventEmitter } = require('node:events');
const net = require('node:net');

// Driver-level doubles for TDS/TNS: no production hooks and no real database writes.
function installDriverFixtures() {
  const tedious = require('tedious'); const oracle = require('oracledb');
  const originalTedious = require.cache[require.resolve('tedious')].exports; const originalOracle = oracle.getConnection;
  const sqlConnections = []; const oracleConnections = []; const oracleConfigs = [];
  class FakeSQLConnection extends EventEmitter {
    constructor(config) { super(); this.config = config; this.schema = 'dbo'; this.database = config.options.database || 'master'; this.queries = []; sqlConnections.push(this); }
    connect(callback) { queueMicrotask(() => callback(this.config.authentication.options.password === 'bad' ? new Error('Login failed') : undefined)); }
    execSqlBatch(request) {
      const sql = request.sqlTextOrProcedure; this.queries.push(sql);
      queueMicrotask(() => {
        if (/SYNTAX_ERROR/.test(sql)) { request.callback(new Error('Incorrect syntax')); return; }
        let names = ['id', 'nombre']; let rows = [[1, 'Ana'], [2, 'Luis']];
        if (/SELECT SCHEMA_NAME\(\), DB_NAME\(\)/.test(sql)) { names = ['schema', 'database']; rows = [[this.schema, this.database]]; }
        else if (/FROM sys.schemas/.test(sql)) { names = ['name']; rows = [['dbo'], ['sales']]; }
        else if (/FROM sys.objects/.test(sql)) { names = ['schema', 'name', 'type']; rows = [['dbo', 'clientes', 'table'], ['sales', 'orders', 'table'], ['dbo', 'calc', 'function']]; }
        else if (/^USE\s+/i.test(sql)) { this.database = sql.match(/^USE\s+\[?([\w]+)/i)[1]; this.emit('databaseChange', this.database); names = []; rows = []; }
        else if (/^SELECT.*large/i.test(sql)) rows = Array.from({ length: 1002 }, (_, id) => [id, 'x']);
        else if (!/^\s*(SELECT|WITH)/i.test(sql)) { names = []; rows = []; }
        const resultset = () => { request.emit('columnMetadata', names.map(colName => ({ colName }))); for (const row of rows) request.emit('row', row.map(value => ({ value }))); request.emit('done', rows.length || 1); };
        resultset(); if (sql.includes('MULTI')) resultset();
        request.callback(null, rows.length); request.emit('requestCompleted');
      });
    }
    close() { this.closed = true; this.emit('end'); }
  }
  class FakeOracleConnection {
    constructor(config) { this.config = config; this.schema = 'HR'; this.queries = []; this.closedSets = 0; this.pendingWrites = 0; oracleConnections.push(this); }
    async execute(sql, binds, options = {}) {
      this.queries.push({ sql, binds, options });
      if (/SYNTAX_ERROR/.test(sql)) throw new Error('ORA-00900: invalid SQL statement');
      if (/FROM ALL_OBJECTS/.test(sql)) return { rows: [['HR', 'CLIENTES', 'table'], ['SALES', 'ORDERS', 'table'], ['HR', 'CALC', 'function']] };
      if (/^ALTER SESSION SET CURRENT_SCHEMA/.test(sql)) { this.schema = sql.match(/= "((?:""|[^"])*)"/)[1].replaceAll('""', '"'); return {}; }
      if (/^SELECT SYS_CONTEXT\('USERENV','CURRENT_SCHEMA'\) FROM DUAL/.test(sql)) return { rows: [[this.schema]] };
      if (/^\s*SELECT/i.test(sql)) {
        const rows = /large/i.test(sql) ? Array.from({ length: 1002 }, (_, id) => [String(id), 'x']) : [['1', 'Ana'], ['2', 'Luis']];
        return { metaData: [{ name: 'ID' }, { name: 'NOMBRE' }], resultSet: { getRows: async count => rows.slice(0, count), close: async () => { this.closedSets++; } } };
      }
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) { this.pendingWrites++; return { rowsAffected: 1 }; }
      if (/^COMMIT/i.test(sql)) { this.pendingWrites = 0; this.committed = true; }
      if (/^ROLLBACK/i.test(sql)) this.pendingWrites = 0;
      return {};
    }
    async close() { this.closed = true; this.pendingWrites = 0; }
  }
  require.cache[require.resolve('tedious')].exports = { ...tedious, Connection: FakeSQLConnection };
  oracle.getConnection = async config => { oracleConfigs.push(config); if (config.password === 'bad') throw new Error('ORA-01017: invalid username/password'); return new FakeOracleConnection(config); };
  return { sqlConnections, oracleConnections, oracleConfigs, restore() { require.cache[require.resolve('tedious')].exports = originalTedious; oracle.getConnection = originalOracle; } };
}

async function startPostgresFixture() {
  const sockets = new Set(); const queries = [];
  const packet = (kind, body) => { const message = Buffer.alloc(5 + body.length); message[0] = kind.charCodeAt(0); message.writeInt32BE(body.length + 4, 1); body.copy(message, 5); return message; };
  const cstring = value => Buffer.from(value + '\0');
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let pending = Buffer.alloc(0); let startup = true; let schema = 'public';
    const sendRows = (names, rows) => {
      const count = Buffer.alloc(2); count.writeInt16BE(names.length);
      const fields = names.map(name => { const data = Buffer.alloc(18); data.writeInt32BE(25, 6); data.writeInt16BE(-1, 10); data.writeInt32BE(-1, 12); return Buffer.concat([cstring(name), data]); });
      socket.write(packet('T', Buffer.concat([count, ...fields])));
      for (const row of rows) {
        const values = row.map(value => { const data = value === null ? null : Buffer.from(String(value)); const size = Buffer.alloc(4); size.writeInt32BE(data ? data.length : -1); return data ? Buffer.concat([size, data]) : size; });
        socket.write(packet('D', Buffer.concat([count, ...values])));
      }
      socket.write(packet('C', cstring('SELECT ' + rows.length)));
    };
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= (startup ? 4 : 5)) {
        const length = pending.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (pending.length < length) return;
        const message = pending.subarray(0, length); pending = pending.subarray(length);
        if (startup) {
          startup = false; socket.write(packet('R', Buffer.alloc(4))); socket.write(packet('S', Buffer.concat([cstring('server_version'), cstring('16.0')]))); socket.write(packet('S', Buffer.concat([cstring('client_encoding'), cstring('UTF8')]))); socket.write(packet('Z', Buffer.from('I'))); continue;
        }
        if (message[0] === 88) { socket.end(); return; }
        if (message[0] !== 81) continue;
        const sql = message.subarray(5, -1).toString(); queries.push(sql);
        if (sql === 'SELECT current_schema(), current_database()') sendRows(['current_schema', 'current_database'], [[schema, 'lqtac']]);
        else if (/SELECT nspname FROM pg_namespace/.test(sql)) sendRows(['nspname'], [['public'], ['sales']]);
        else if (/FROM pg_class/.test(sql)) sendRows(['schema', 'name', 'type', 'oid'], [['public', 'clientes', 'table', null], ['sales', 'orders', 'table', null], ['public', 'calc', 'function', '123']]);
        else if (/^SET search_path TO/.test(sql)) { schema = sql.match(/TO "((?:""|[^"])*)"/)[1].replaceAll('""', '"'); socket.write(packet('C', cstring('SET'))); }
        else if (/SYNTAX_ERROR/.test(sql)) socket.write(packet('E', Buffer.from('SERROR\0C42601\0Msyntax error\0\0')));
        else if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) socket.write(packet('C', cstring('UPDATE 3')));
        else { sendRows(['id', 'nombre'], /large/i.test(sql) ? Array.from({ length: 1002 }, (_, id) => [id, 'x']) : [['1', 'Ana'], ['2', 'Luis']]); if (sql.includes('MULTI')) sendRows(['empty'], []); }
        socket.write(packet('Z', Buffer.from('I')));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { profile: { engine: 'postgresql', name: 'PostgreSQL fixture', host: '127.0.0.1', port: server.address().port, database: 'lqtac', username: 'test' }, queries,
    close: () => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); }) };
}
module.exports = { installDriverFixtures, startPostgresFixture };
