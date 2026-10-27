export function quoteIdentifier(name, engine) {
  if (engine === 'sqlserver') return '[' + name.replaceAll(']', ']]') + ']';
  const quote = ['postgresql', 'oracle', 'sqlite'].includes(engine) ? '"' : '`';
  return quote + name.replaceAll(quote, quote + quote) + quote;
}
export const sqlLiteral = value => "'" + value.replaceAll("'", "''") + "'";
export function initialQuery(engine) {
  return { mongodb: '{"ping":1}', clickhouse: 'SELECT currentDatabase() AS base_de_datos, version() AS version_servidor;',
    postgresql: 'SELECT current_database() AS base_de_datos, current_schema() AS esquema, version() AS version_servidor;',
    sqlserver: 'SELECT DB_NAME() AS base_de_datos, SCHEMA_NAME() AS esquema, @@VERSION AS version_servidor;',
    oracle: "SELECT SYS_CONTEXT('USERENV','DB_NAME') AS BASE_DE_DATOS, SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS ESQUEMA FROM DUAL" }[engine] || 'SELECT DATABASE() AS base_de_datos, VERSION() AS version_servidor;';
}
