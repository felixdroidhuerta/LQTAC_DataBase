const { createHash } = require('node:crypto');
const { identifier, literal } = require('./mysql-table.cjs');

async function query(adapter, sql) {
  const [rows, fields] = await adapter.connection.promise().query({ sql, timeout: 30000 });
  return rows.map(row => Object.fromEntries(fields.map((field, index) => [field.name, row[index]])));
}
async function inspectTrigger(adapter, schema, name) {
  const target = `${identifier(schema)}.${identifier(name)}`;
  const [create] = await query(adapter, `SHOW CREATE TRIGGER ${target}`);
  const ddl = create?.['SQL Original Statement'] || create?.['Create Trigger'];
  if (!ddl) throw new Error('No se puede leer la definición completa del trigger.');
  const [mode] = await query(adapter, 'SELECT @@SESSION.sql_mode AS sql_mode');
  const all = await query(adapter, `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT, DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ${literal(schema, mode.sql_mode)}`);
  const found = all.find(item => item.TRIGGER_NAME === name);
  if (!found) throw new Error('El trigger ya no existe o no es visible para este usuario.');
  let ordered;
  try { ordered = await query(adapter, `SELECT TRIGGER_NAME, ACTION_ORDER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ${literal(schema, mode.sql_mode)} AND EVENT_OBJECT_TABLE = ${literal(found.EVENT_OBJECT_TABLE, mode.sql_mode)} AND ACTION_TIMING = ${literal(found.ACTION_TIMING, mode.sql_mode)} AND EVENT_MANIPULATION = ${literal(found.EVENT_MANIPULATION, mode.sql_mode)} ORDER BY ACTION_ORDER`); }
  catch (error) { if (error.code !== 'ER_BAD_FIELD_ERROR') throw error; ordered = [{ TRIGGER_NAME: name }]; }
  const index = ordered.findIndex(item => item.TRIGGER_NAME === name);
  const order = index > 0 ? { kind: 'FOLLOWS', name: ordered[index - 1].TRIGGER_NAME } : ordered.length > 1 ? { kind: 'PRECEDES', name: ordered[1].TRIGGER_NAME } : null;
  const result = { schema, table: found.EVENT_OBJECT_TABLE, name, timing: found.ACTION_TIMING, event: found.EVENT_MANIPULATION, body: found.ACTION_STATEMENT, definer: found.DEFINER, ddl, sqlMode: create.sql_mode || '', charset: create.character_set_client || '', collation: create.collation_connection || '', order };
  result.version = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  return result;
}
function createTriggerSQL(draft, original = null) {
  if (!draft || !['BEFORE', 'AFTER'].includes(draft.timing) || !['INSERT', 'UPDATE', 'DELETE'].includes(draft.event)) throw new Error('Momento o evento del trigger no válido.');
  if (typeof draft.body !== 'string' || !draft.body.trim() || draft.body.length > 1_000_000 || /^\s*DELIMITER\b/im.test(draft.body)) throw new Error('Escribe el cuerpo SQL sin instrucciones DELIMITER.');
  if (original && (draft.schema !== original.schema || draft.table !== original.table)) throw new Error('No se puede cambiar la tabla desde este editor.');
  let definer = '';
  if (original?.definer) {
    const at = original.definer.lastIndexOf('@');
    if (at < 1) throw new Error('No se pudo interpretar el definer original.');
    const account = value => '`' + value.replaceAll('`', '``') + '`';
    definer = ` DEFINER=${account(original.definer.slice(0, at))}@${account(original.definer.slice(at + 1))}`;
  }
  const ordering = original && original.timing === draft.timing && original.event === draft.event && original.order ? ` ${original.order.kind} ${identifier(original.order.name)}` : '';
  return `CREATE${definer} TRIGGER ${identifier(draft.schema)}.${identifier(draft.name)}\n${draft.timing} ${draft.event} ON ${identifier(draft.schema)}.${identifier(draft.table)}\nFOR EACH ROW${ordering}\n${draft.body.trim().replace(/;\s*$/, '')};`;
}
async function canRestoreDefiner(adapter, original) {
  if (!original) return;
  const [user] = await query(adapter, 'SELECT CURRENT_USER() AS current_user');
  if (user.current_user === original.definer) return;
  const grants = await query(adapter, 'SHOW GRANTS FOR CURRENT_USER()');
  const allowed = grants.some(row => /\b(?:SUPER|SET_USER_ID|SET_ANY_DEFINER|ALL PRIVILEGES)\b[\s\S]*\bON\s+\*\.\*/i.test(Object.values(row)[0]));
  if (!allowed) throw new Error('El definer original pertenece a otra cuenta y no se han podido confirmar permisos para recrearlo. No se ha eliminado el trigger.');
}
// DROP + CREATE cannot be atomic in MySQL. Restore only on a healthy connection;
// after transport errors the outcome is uncertain and must be checked explicitly.
async function replaceTrigger(adapter, original, draft) {
  await canRestoreDefiner(adapter, original);
  const create = createTriggerSQL(draft, original);
  if (original) await adapter.execute(`DROP TRIGGER ${identifier(original.schema)}.${identifier(original.name)}`);
  try { await adapter.execute(create); return { applied: true }; }
  catch (error) {
    if (!original) throw error;
    if (!adapter.alive) return { applied: false, restored: false, uncertain: true, error: `Se perdió la conexión tras eliminar el trigger. Comprueba su estado antes de reintentar. ${error.message}` };
    try { await adapter.execute(createTriggerSQL(original, original)); return { applied: false, restored: true, error: `No se aplicó el cambio; se restauró el trigger original. ${error.message}` }; }
    catch (restoreError) { return { applied: false, restored: false, error: `No se pudo restaurar automáticamente el trigger original. ${error.message} Restauración: ${restoreError.message}` }; }
  }
}
module.exports = { inspectTrigger, createTriggerSQL, replaceTrigger, canRestoreDefiner };
