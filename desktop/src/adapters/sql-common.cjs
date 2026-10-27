function identifier(name, engine) {
  if (typeof name !== 'string' || !name || name.length > 255 || name.includes('\0')) throw new Error('Identificador no válido.');
  return engine === 'sqlserver' ? '[' + name.replaceAll(']', ']]') + ']' : '"' + name.replaceAll('"', '""') + '"';
}
function validateSQL(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 1_000_000) throw new Error('Escribe SQL de hasta 1 MB.');
}
function cell(value) {
  if (value && typeof value.getData === 'function' && typeof value.destroy === 'function') { value.destroy(); return '[LOB: usa SUBSTR o una conversión en la consulta para leerlo]'; }
  if (Buffer.isBuffer(value)) return `[BLOB ${value.length} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value !== null && typeof value === 'object' ? JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item) : value;
}
function resultCollector(limit = 1000) {
  let bytes = 0;
  return {
    create: columns => ({ columns, values: [], truncated: false }),
    append(result, row) {
      if (result.values.length >= limit) { for (const value of row) if (value && typeof value.getData === 'function' && typeof value.destroy === 'function') value.destroy(); result.truncated = true; return; }
      const values = row.map(cell);
      bytes += Buffer.byteLength(JSON.stringify(values));
      if (bytes > 16 * 1024 * 1024) throw new Error('El resultado supera 16 MB. Reduce columnas o añade filtros. La sentencia ya se envió al servidor.');
      result.values.push(values);
    }
  };
}
function catalogFromRows(names, rows, database) {
  const schemas = names.map(name => ({ name, objects: [] }));
  const byName = new Map(schemas.map(schema => [schema.name, schema]));
  for (const [schema, name, type, oid] of rows) {
    if (!byName.has(schema)) { const item = { name: schema, objects: [] }; schemas.push(item); byName.set(schema, item); }
    byName.get(schema).objects.push({ name, type, ...(oid ? { oid: String(oid) } : {}) });
  }
  return { schemas, database };
}
module.exports = { identifier, validateSQL, cell, resultCollector, catalogFromRows };
