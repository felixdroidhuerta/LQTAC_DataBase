const oracledb = require('oracledb');
const { identifier, validateSQL, resultCollector, catalogFromRows } = require('./sql-common.cjs');

function oracleStatement(source) {
  validateSQL(source);
  const prefix = source.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
  const block = /^(?:BEGIN\b|DECLARE\b|CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|PACKAGE|TYPE)\b)/i.test(prefix);
  if (block) return source.replace(/\r?\n\s*\/\s*$/, '');
  // Remove the client statement terminator while preserving comments and literal semicolons.
  let last = -1; let quote = null;
  for (let index = 0; index < source.length; index++) {
    const c = source[index];
    if (quote) { if (c === quote) { if (source[index + 1] === quote) index++; else quote = null; } last = index; continue; }
    if (source.startsWith('--', index)) { const end = source.indexOf('\n', index); if (end < 0) break; index = end; continue; }
    if (source.startsWith('/*', index)) { const end = source.indexOf('*/', index + 2); if (end < 0) break; index = end + 1; continue; }
    if (c === "'" || c === '"') quote = c;
    if (!/\s/.test(c)) last = index;
  }
  return source[last] === ';' ? source.slice(0, last) + source.slice(last + 1) : source;
}
class OracleAdapter {
  static async open(profile, password) {
    if (!profile.database || !/^[\p{L}\p{N}_.-]+$/u.test(profile.database)) throw new Error('Oracle requiere un nombre de servicio válido, por ejemplo FREEPDB1.');
    if (/[\s\/?#@\[\]\\()]/.test(profile.host)) throw new Error('Introduce solo el host o IP de Oracle, sin protocolo ni descriptor TNS.');
    const host = profile.host.includes(':') ? `[${profile.host}]` : profile.host;
    const connection = await oracledb.getConnection({ user: profile.username, password,
      connectString: `${profile.tls ? 'tcps' : 'tcp'}://${host}:${profile.port}/${encodeURIComponent(profile.database)}?connect_timeout=10&transport_connect_timeout=10&retry_count=0`,
      ...(profile.tls ? { sslServerDNMatch: true } : {}) });
    connection.callTimeout = 30000;
    return new OracleAdapter(connection, profile.database);
  }
  constructor(connection, databaseName) { this.connection = connection; this.databaseName = databaseName; this.alive = true; this.scope = 'schema'; }
  async currentDatabase() {
    const result = await this.connection.execute("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL", [], { outFormat: oracledb.OUT_FORMAT_ARRAY });
    return result.rows[0][0];
  }
  async catalog() {
    const database = await this.currentDatabase();
    const objects = await this.connection.execute(`SELECT OWNER, OBJECT_NAME, CASE OBJECT_TYPE WHEN 'VIEW' THEN 'view' WHEN 'MATERIALIZED VIEW' THEN 'view' WHEN 'PROCEDURE' THEN 'procedure' WHEN 'FUNCTION' THEN 'function' ELSE 'table' END
      FROM ALL_OBJECTS WHERE OBJECT_TYPE IN ('TABLE','VIEW','MATERIALIZED VIEW','PROCEDURE','FUNCTION')
      AND (OBJECT_TYPE <> 'TABLE' OR OBJECT_NAME NOT IN (SELECT MVIEW_NAME FROM ALL_MVIEWS WHERE OWNER=ALL_OBJECTS.OWNER)) ORDER BY OWNER,OBJECT_NAME`, [], { outFormat: oracledb.OUT_FORMAT_ARRAY });
    return catalogFromRows([...new Set([database, ...objects.rows.map(([owner]) => owner)])], objects.rows, database);
  }
  async selectDatabase(name) { await this.connection.execute('ALTER SESSION SET CURRENT_SCHEMA = ' + identifier(name)); }
  async execute(source) {
    if (!this.alive) throw new Error('La sesión está cerrada. Vuelve a conectar.');
    const sql = oracleStatement(source); const started = performance.now(); let result;
    const collector = resultCollector();
    try {
      result = await this.connection.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_ARRAY, resultSet: true, autoCommit: false,
        fetchTypeHandler: metadata => metadata.dbType === oracledb.DB_TYPE_NUMBER ? { type: oracledb.STRING } : undefined });
      const results = [];
      for (const set of [result.resultSet, ...(result.implicitResults || [])].filter(Boolean)) {
        const output = collector.create((set.metaData || result.metaData).map(field => field.name));
        const rows = await set.getRows(1001);
        for (const row of rows) collector.append(output, row);
        results.push(output);
      }
      return { results, changes: result.rowsAffected || 0, elapsed: Math.round(performance.now() - started) };
    } catch (error) { if (/NJS-(003|500|501|503|510|511)|DPI-1010|ORA-0311[34]/.test(error.message)) this.close(); throw error; }
    finally { if (result) { const closed = await Promise.allSettled([result.resultSet, ...(result.implicitResults || [])].filter(Boolean).map(set => set.close())); if (closed.some(item => item.status === 'rejected')) this.close(); } }
  }
  close() { this.alive = false; this.connection.close().catch(() => {}); }
}
module.exports = { OracleAdapter, oracleStatement };
