const fs = require('node:fs');
const path = require('node:path');
const { cancelQuery } = require('./cancel-query.cjs');
const DEFAULT_TIMEOUT_SECONDS = 30;
function validateSettings(value) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.queryTimeoutSeconds) || value.queryTimeoutSeconds < 1 || value.queryTimeoutSeconds > 86400) throw new Error('El tiempo máximo debe ser un número entero entre 1 y 86400 segundos.');
  return { queryTimeoutSeconds: value.queryTimeoutSeconds };
}
class SettingsStore {
  constructor(directory) {
    this.file = path.join(directory, 'settings.json');
    this.value = { queryTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS };
    try { this.value = validateSettings(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* Missing or invalid settings use the documented defaults. */ }
  }
  get() { return { ...this.value }; }
  save(value) {
    const next = validateSettings(value);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    this.value = next;
    return this.get();
  }
}
// Return to the UI at the deadline, while keeping this physical session reserved until drained.
async function executeTimed(adapter, engine, sql, timeoutMs, { signal, openControl, runId, onCancellationReleased, execute, rowLimit = 1000 } = {}) {
  if (adapter.pendingExecution) throw new Error('La consulta anterior aún está terminando en este servidor. Puedes usar otra conexión o reintentar Detener.');
  if (engine === 'sqlite') return execute?execute(sql,{}):adapter.execute(sql,{rowLimit});
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) throw new Error('Tiempo máximo de consulta no válido.');
  if (signal?.aborted) throw Object.assign(new Error('Ejecución cancelada por el usuario.'), { code: 'QUERY_CANCELLED' });
  let settled = false, reason, cancelResolve, attempt = null, pending;
  const controls = [];
  const operationController = new AbortController();
  const outcome = Promise.resolve().then(() => execute?execute(sql,{timeoutMs,managed:true,signal:operationController.signal}):adapter.execute(sql, { timeoutMs, managed: true, rowLimit, signal: operationController.signal })).then(value => ({ value }), error => ({ error })).then(result => { settled = true; return result; });
  const cancelled = new Promise(resolve => { cancelResolve = resolve; });
  function requestCancel(manual) {
    if (settled || attempt) return;
    const first = !reason;
    if (first) {
      reason = Object.assign(new Error(manual ? 'Consulta cancelada por el usuario' : 'Agotado tiempo máximo de consulta'), { code: manual ? 'QUERY_CANCELLED' : 'QUERY_TIMEOUT' });
      operationController.abort(reason);
      pending = { runId, cancel: () => requestCancel(true), done: null };
      adapter.pendingExecution = pending;
    }
    const current = Promise.resolve().then(() => cancelQuery(adapter, engine, openControl, () => !settled && adapter.alive !== false)).catch(error => { if (pending) pending.controlError = error.message; }).finally(() => {
      if (attempt === current) attempt = null;
    });
    attempt = current; controls.push(current);
    if (first) {
      pending.done = (async () => {
      try {
        await outcome;
        await Promise.all(controls);
      } finally {
        if (adapter.pendingExecution === pending) delete adapter.pendingExecution;
        try { onCancellationReleased?.(); } catch { /* A closed renderer must not retain the session lock. */ }
      }
      })();
      cancelResolve({ error: reason });
    }
  }
  const abort = () => requestCancel(true);
  signal?.addEventListener('abort', abort, { once: true });
  signal?.addEventListener('cancel-request', abort);
  const timer = setTimeout(() => requestCancel(false), timeoutMs);
  try {
    const result = await Promise.race([outcome, cancelled]);
    if (reason) throw reason;
    if (result.error) throw result.error;
    return result.value;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); signal?.removeEventListener('cancel-request', abort); }
}
module.exports = { SettingsStore, validateSettings, executeTimed, DEFAULT_TIMEOUT_SECONDS };
