const { Connection, Request } = require('tedious');
const { validateSQL, resultCollector, catalogFromRows } = require('./sql-common.cjs');

class SQLServerAdapter {
  static async open(profile, password) {
    const connection = new Connection({ server: profile.host,
      authentication: { type: 'default', options: { userName: profile.username, password } },
      options: { port: profile.port, ...(profile.database ? { database: profile.database } : {}), encrypt: profile.tls === true,
        trustServerCertificate: false, connectTimeout: 10000, requestTimeout: 30000, cancelTimeout: 5000,
        appName: 'LQTAC Data Base', useColumnNames: false, rowCollectionOnRequestCompletion: false, rowCollectionOnDone: false } });
    const adapter = new SQLServerAdapter(connection);
    try { await new Promise((resolve, reject) => connection.connect(error => error ? reject(error) : resolve())); return adapter; }
    catch (error) { adapter.close(); throw error; }
  }
  constructor(connection) {
    this.connection = connection; this.alive = true; this.scope = 'schema';
    connection.on('error', () => { this.alive = false; }); connection.on('end', () => { this.alive = false; });
    connection.on('databaseChange', name => { this.databaseName = name; this.catalogDirty = true; });
  }
  async currentDatabase() {
    const result = await this.run('SELECT SCHEMA_NAME(), DB_NAME()', 10);
    const row = result.results[0]?.values[0] || []; this.databaseName = row[1] || ''; return row[0] || 'dbo';
  }
  async catalog() {
    const database = await this.currentDatabase();
    const names = await this.run('SELECT name FROM sys.schemas ORDER BY name', 100000);
    const objects = await this.run(`SELECT s.name, o.name, CASE WHEN o.type='V' THEN 'view' WHEN o.type IN ('P','PC') THEN 'procedure' WHEN o.type IN ('FN','IF','TF','FS','FT') THEN 'function' ELSE 'table' END
      FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.type IN ('U','V','P','PC','FN','IF','TF','FS','FT') AND o.is_ms_shipped=0 ORDER BY s.name,o.name`, 100000);
    this.catalogDirty = false;
    return catalogFromRows((names.results[0]?.values || []).map(([name]) => name), objects.results[0]?.values || [], database);
  }
  async execute(sql) { validateSQL(sql); return this.run(sql); }
  async run(sql, limit = 1000) {
    if (!this.alive) throw new Error('La sesión está cerrada. Vuelve a conectar.');
    const started = performance.now(); const collector = resultCollector(limit); const results = []; let current; let changes = 0;
    return new Promise((resolve, reject) => {
      let failed;
      const request = new Request(sql, error => {
        if (error?.code === 'ETIMEOUT' || failed) this.close();
        if (error || failed) reject(failed || error);
        else resolve({ results, changes, elapsed: Math.round(performance.now() - started) });
      });
      request.on('columnMetadata', fields => { current = fields.length ? collector.create(fields.map(field => field.colName)) : null; if (current) results.push(current); });
      request.on('row', row => { if (!current || failed) return; try { collector.append(current, row.map(column => column.value)); } catch (error) { failed = error; request.cancel(); } });
      const done = count => { if (!current && Number.isFinite(count)) changes += count; current = null; };
      request.on('done', done); request.on('doneInProc', done);
      // A batch runs on the same physical connection: USE, temporary tables and transactions survive requests.
      try { this.connection.execSqlBatch(request); } catch (error) { reject(error); }
    });
  }
  close() { this.alive = false; this.connection.close(); }
}
module.exports = { SQLServerAdapter };
