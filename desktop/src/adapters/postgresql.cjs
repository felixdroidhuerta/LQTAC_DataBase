const { Client, Query } = require('pg');
const { identifier, validateSQL, resultCollector, catalogFromRows } = require('./sql-common.cjs');

class PostgreSQLAdapter {
  static async open(profile, password) {
    const client = new Client({ host: profile.host, port: profile.port, user: profile.username, password,
      database: profile.database || 'postgres', ssl: profile.tls ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 10000, statement_timeout: 30000, application_name: 'LQTAC Data Base', keepAlive: true });
    const adapter = new PostgreSQLAdapter(client);
    try { await client.connect(); return adapter; } catch (error) { adapter.close(); throw error; }
  }
  constructor(client) {
    this.client = client; this.alive = true; this.scope = 'schema';
    client.on('error', () => { this.alive = false; }); client.on('end', () => { this.alive = false; });
  }
  async currentDatabase() {
    const { rows } = await this.client.query('SELECT current_schema(), current_database()'); this.databaseName = rows[0].current_database;
    return rows[0].current_schema || '';
  }
  async catalog() {
    const database = await this.currentDatabase();
    const names = await this.client.query({ text: "SELECT nspname FROM pg_namespace WHERE has_schema_privilege(oid, 'USAGE') ORDER BY nspname", rowMode: 'array' });
    const objects = await this.client.query({ text: `SELECT n.nspname, c.relname, CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END, NULL::text
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','v','m','f') AND has_schema_privilege(n.oid,'USAGE')
      UNION ALL SELECT n.nspname, p.proname, CASE WHEN p.prokind='p' THEN 'procedure' ELSE 'function' END, p.oid::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN ('p','f') AND has_schema_privilege(n.oid,'USAGE') AND has_function_privilege(p.oid,'EXECUTE') ORDER BY 1,2`, rowMode: 'array' });
    return catalogFromRows(names.rows.map(([name]) => name), objects.rows, database);
  }
  async selectDatabase(name) { await this.client.query('SET search_path TO ' + identifier(name)); }
  async execute(sql) {
    validateSQL(sql); if (!this.alive) throw new Error('La sesión está cerrada. Vuelve a conectar.');
    const started = performance.now(); const collector = resultCollector(); const collected = new Map();
    return new Promise((resolve, reject) => {
      const query = new Query({ text: sql, rowMode: 'array' });
      const timeout = setTimeout(() => { this.close(); reject(new Error('La operación superó 35 segundos. Se ha cerrado la sesión; comprueba el estado antes de repetir escrituras.')); }, 35000);
      query.on('row', (row, result) => {
        try { if (!collected.has(result)) collected.set(result, collector.create(result.fields.map(field => field.name))); collector.append(collected.get(result), row); }
        catch (error) { clearTimeout(timeout); this.close(); reject(error); }
      });
      query.on('error', error => { clearTimeout(timeout); reject(error); });
      query.on('end', raw => {
        clearTimeout(timeout); const results = []; let changes = 0;
        for (const result of Array.isArray(raw) ? raw : [raw]) {
          if (result.fields?.length) results.push(collected.get(result) || collector.create(result.fields.map(field => field.name)));
          if (['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(result.command)) changes += result.rowCount || 0;
        }
        resolve({ results, changes, elapsed: Math.round(performance.now() - started) });
      });
      try { this.client.query(query); } catch (error) { clearTimeout(timeout); reject(error); }
    });
  }
  close() { this.alive = false; this.client.end().catch(() => {}); }
}
module.exports = { PostgreSQLAdapter };
