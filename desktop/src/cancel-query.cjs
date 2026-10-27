// Cancellation uses a separate control channel where the server protocol requires it.
// Never queue a KILL on the busy connection, nor reuse it until cancellation has drained.
async function cancelQuery(adapter, engine, openControl, isCurrent) {
  if (typeof adapter.cancelQuery === 'function') return adapter.cancelQuery();
  if (engine === 'sqlserver') { adapter.activeRequest?.cancel(); return; }
  if (engine === 'oracle') { await adapter.connection.break(); return; }
  if (typeof openControl !== 'function') throw new Error('No se pudo abrir el canal de cancelación.');
  const id = engine === 'mysql' || engine === 'mariadb' ? adapter.connection.threadId : engine === 'postgresql' ? adapter.client.processID : adapter.activeQueryId;
  if (id === undefined || id === null) throw new Error('No hay una consulta activa que cancelar.');
  const control = await openControl();
  try {
    // A late control connection must not cancel a later statement or a reused server process ID.
    if (!isCurrent()) return;
    if (['mysql', 'mariadb', 'postgresql'].includes(engine) && (!Number.isInteger(id) || id < 1)) throw new Error('Identificador de sesión no válido.');
    if (engine === 'mysql' || engine === 'mariadb') await control.connection.promise().query({ sql: 'KILL QUERY ' + id, timeout: 4000 });
    else if (engine === 'postgresql') await control.client.query({ text: 'SELECT pg_cancel_backend(' + id + ')', query_timeout: 4000 });
    else if (engine === 'clickhouse') {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Identificador de consulta no válido.');
      await control.client.command({ query: `KILL QUERY WHERE query_id = '${id}' SYNC` });
      adapter.queryAbort?.abort();
    } else if (engine === 'mongodb') {
      const admin = control.client.db('admin');
      const response = await admin.command({ aggregate: 1, pipeline: [
        { $currentOp: { allUsers: false } },
        { $match: { $or: [{ 'command.comment.lqtacRequestId': id }, { 'originatingCommand.comment.lqtacRequestId': id }] } },
        { $project: { opid: 1, 'command.createIndexes': 1 } }
      ], cursor: {} }, { timeoutMS: 4000 });
      for (const operation of response.cursor?.firstBatch || []) {
        if (!isCurrent()) break;
        if (operation.command?.createIndexes) throw new Error('El servidor no admite killOp para crear índices.');
        await admin.command({ killOp: 1, op: operation.opid }, { timeoutMS: 4000 });
      }
      adapter.queryAbort?.abort();
    } else throw new Error('Este motor no admite cancelación.');
  } finally { control.close(); }
}
module.exports = { cancelQuery };
