const initSqlJs = require('sql.js');

// Adapter contract: execute, schema, close. The renderer never accesses a driver.
class SQLiteAdapter {
  static async open() {
    const SQL = await initSqlJs();
    return new SQLiteAdapter(new SQL.Database());
  }

  static async fromBytes(bytes) {
    const SQL = await initSqlJs();
    return new SQLiteAdapter(new SQL.Database(bytes));
  }

  constructor(database) { this.database = database; }

  execute(sql, { rowLimit = 1000 } = {}) {
    if (typeof sql !== 'string' || !sql.trim()) throw new Error('Escribe una consulta SQL.');
    if (sql.length > 1_000_000) throw new Error('La consulta supera el tamaño permitido.');
    const started = performance.now();
    const results = [];
    // Iterate statements so a single large result does not exhaust renderer memory.
    for (const statement of this.database.iterateStatements(sql)) {
      const columns = statement.getColumnNames();
      const values = [];
      let truncated = false;
      while (statement.step()) {
        if (rowLimit !== 0 && values.length >= rowLimit) { truncated = true; break; }
        values.push(statement.get().map(value => value instanceof Uint8Array ? `[BLOB ${value.length} bytes]` : value));
      }
      if (columns.length) results.push({ columns, values, truncated });
    }
    return { results, changes: this.database.getRowsModified(), elapsed: Math.round(performance.now() - started) };
  }

  schema() {
    return this.database.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name")[0]?.values.map(([name, type]) => ({ name, type })) ?? [];
  }

  export() { return this.database.export(); }
  close() { this.database.close(); }
}

module.exports = { SQLiteAdapter };
