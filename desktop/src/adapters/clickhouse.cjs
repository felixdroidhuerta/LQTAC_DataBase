const { createClient, ClickHouseLogLevel } = require('@clickhouse/client');
const { randomUUID } = require('node:crypto');

const cell = value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
class ClickHouseAdapter {
  static async open(profile, password) {
    // Use the HTTP port (8123/8443), rather than the native TCP port (9000).
    const host = profile.host.includes(':') ? `[${profile.host}]` : profile.host;
    const adapter = new ClickHouseAdapter({ url: `${profile.tls ? 'https' : 'http'}://${host}:${profile.port}`, username: profile.username,
      password, database: profile.database || 'default', request_timeout: 30000, max_open_connections: 1,
      session_id: randomUUID(), application: 'LQTAC Data Base', log: { level: ClickHouseLogLevel.OFF } });
    try { await adapter.client.command({ query: 'SELECT 1' }); return adapter; }
    catch (error) { adapter.close(); throw error; }
  }
  constructor(config) { this.config = config; this.client = createClient(config); this.database = config.database; this.alive = true; }
  async currentDatabase() { return this.database; }
  async catalog() {
    const names = await (await this.client.query({ query: 'SHOW DATABASES', format: 'JSONCompact' })).json();
    const tables = await (await this.client.query({ query: 'SELECT database, name, engine FROM system.tables ORDER BY database, name', format: 'JSONCompact' })).json();
    const schemas = names.data.map(([name]) => ({ name, objects: [] }));
    const lookup = new Map(schemas.map(schema => [schema.name, schema]));
    for (const [database, name, engine] of tables.data) lookup.get(database)?.objects.push({ name, type: /View$/.test(engine) ? 'view' : 'table' });
    return { database: this.database, schemas };
  }
  async selectDatabase(name) {
    if (typeof name !== 'string' || !name || name.length > 255) throw new Error('Base de datos no válida.');
    const next = createClient({ ...this.config, database: name });
    try { await next.command({ query: 'SELECT 1' }); } catch (error) { await next.close(); throw error; }
    const previous = this.client; this.client = next; this.config.database = name; this.database = name; await previous.close();
  }
  async execute(sql) {
    if (!this.alive) throw new Error('La sesión está cerrada. Vuelve a conectar.');
    if (typeof sql !== 'string' || !sql.trim() || sql.length > 1_000_000) throw new Error('Escribe una consulta de hasta 1 MB.');
    const started = performance.now();
    const use = /^\s*USE\s+(?:`((?:``|[^`])+)`|([\w]+))\s*;?\s*$/i.exec(sql);
    if (use) { await this.selectDatabase((use[1] || use[2]).replaceAll('``', '`')); return { results: [], changes: 0, elapsed: Math.round(performance.now() - started) }; }
    // The HTTP default format preserves the user's statement, including INSERT/DDL.
    const response = await this.client.exec({ query: sql, http_headers: { 'X-ClickHouse-Format': 'JSONCompact' },
      clickhouse_settings: { max_result_rows: 1001, result_overflow_mode: 'break', max_execution_time: 30 } });
    let size = 0; const chunks = [];
    for await (const chunk of response.stream) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) { response.stream.destroy(); throw new Error('El resultado supera 16 MB. Reduce las columnas o añade filtros. La sentencia ya se envió al servidor.'); }
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return { results: [], changes: 0, elapsed: Math.round(performance.now() - started) };
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('El resultado no es JSONCompact. Omite FORMAT o utiliza FORMAT JSONCompact.'); }
    if (!Array.isArray(data.meta) || !Array.isArray(data.data)) throw new Error('Formato de resultado ClickHouse no compatible. Utiliza JSONCompact.');
    return { results: [{ columns: data.meta.map(field => field.name), values: data.data.slice(0, 1000).map(row => row.map(cell)), truncated: data.data.length > 1000 }], changes: 0, elapsed: Math.round(performance.now() - started) };
  }
  close() { this.alive = false; this.client.close().catch(() => {}); }
}
module.exports = { ClickHouseAdapter };
