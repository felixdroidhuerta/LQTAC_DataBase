const { MongoClient, BSON } = require('mongodb');
const { randomUUID } = require('node:crypto');

function parseCommand(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 1_000_000) throw new Error('Escribe un comando JSON de hasta 1 MB.');
  let command;
  try { command = BSON.EJSON.parse(source, { relaxed: false }); }
  catch { throw new Error('MongoDB utiliza JSON / Extended JSON. Ejemplo: {"find":"clientes","filter":{},"limit":100}. No admite código de mongosh ni SQL.'); }
  if (!command || typeof command !== 'object' || Array.isArray(command) || !Object.keys(command).length) throw new Error('El comando debe ser un objeto JSON.');
  return command;
}
function documentsResult(documents, truncated = false) {
  const serialized = documents.map(doc => BSON.EJSON.serialize(doc, { relaxed: false }));
  const columns = [...new Set(serialized.flatMap(doc => Object.keys(doc)))];
  return { columns, values: serialized.map(doc => columns.map(name => {
    if (!Object.hasOwn(doc, name)) return null;
    const value = doc[name]; return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
  })), truncated };
}
class MongoDBAdapter {
  static async open(profile, password) {
    const host = profile.host.includes(':') ? `[${profile.host}]` : profile.host;
    const client = new MongoClient(`mongodb://${host}:${profile.port}`, {
      ...(profile.username ? { auth: { username: profile.username, password }, authSource: profile.authSource || 'admin' } : {}), tls: profile.tls === true,
      serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, timeoutMS: 30000, retryWrites: false, maxPoolSize: 1,
      appName: 'LQTAC Data Base'
    });
    const adapter = new MongoDBAdapter(client, profile.database || 'test');
    try { await client.connect(); await client.db(adapter.database).command({ ping: 1 }); return adapter; }
    catch (error) { adapter.close(); throw error; }
  }
  constructor(client, database) { this.client = client; this.database = database; this.alive = true; }
  async currentDatabase() { return this.database; }
  async catalog() {
    let databases; let warning;
    try { databases = (await this.client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true })).databases.map(item => item.name); }
    catch { databases = [this.database]; warning = 'No se pudieron listar todas las bases. Se muestra la base seleccionada.'; }
    if (!databases.includes(this.database)) databases.push(this.database);
    const schemas = [];
    for (const name of databases) {
      let objects = [];
      try { objects = (await this.client.db(name).listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray()).map(item => ({ name: item.name, type: item.type === 'view' ? 'view' : 'collection' })); }
      catch { warning = 'Algunas colecciones no son visibles para este usuario.'; }
      schemas.push({ name, objects });
    }
    return { database: this.database, schemas, warning };
  }
  async selectDatabase(name) {
    if (typeof name !== 'string' || !name || name.length > 255 || /[\/\\. "$\0]/.test(name)) throw new Error('Base de datos MongoDB no válida.');
    this.database = name;
  }
  async execute(source, { timeoutMs = 30000, rowLimit = 1000, managed = false, signal } = {}) {
    if (!this.alive) throw new Error('La sesión está cerrada. Vuelve a conectar.');
    const parsed = parseCommand(source); const { $db, ...command } = parsed;
    if ($db !== undefined && (typeof $db !== 'string' || !$db || $db.length > 255 || /[\/\\. "$\0]/.test($db))) throw new Error('El campo $db debe indicar una base válida.');
    const started = performance.now(); const db = this.client.db($db || this.database);
    const kind = Object.keys(command)[0]; let result; let changes = 0;
    if (!kind) throw new Error('El comando JSON está vacío.');
    signal?.throwIfAborted();
    const queryId = randomUUID(); this.activeQueryId = queryId; this.queryAbort = new AbortController();
    const commandOptions = { timeoutMS: managed ? timeoutMs + 10000 : timeoutMs, signal: this.queryAbort.signal };
    command.comment = { lqtacRequestId: queryId, ...(command.comment === undefined ? {} : { original: command.comment }) };
    try {
    if (kind === 'aggregate' && !command.cursor) command.cursor = {};
    // Cursor commands are consumed through the driver so getMore and cursor cleanup work.
    if (['find', 'aggregate', 'listCollections', 'listIndexes'].includes(kind)) {
      const cursor = db.runCursorCommand({ ...command, maxTimeMS: timeoutMs }, { ...commandOptions, timeoutMode: 'cursorLifetime' });
      const documents = []; let bytes = 0;
      try { for await (const document of cursor) { bytes += BSON.calculateObjectSize(document); if (bytes > 16 * 1024 * 1024) throw new Error('El resultado supera 16 MB. Utiliza projection, filtros o limit.'); documents.push(document); if (rowLimit !== 0 && documents.length > rowLimit) break; } }
      finally { await cursor.close(); }
      result = documentsResult(rowLimit === 0 ? documents : documents.slice(0, rowLimit), rowLimit !== 0 && documents.length > rowLimit);
    } else {
      if (['getMore', 'killCursors'].includes(kind)) throw new Error('Los cursores se gestionan automáticamente. Usa find o aggregate.');
      const response = await db.command({ ...command, maxTimeMS: timeoutMs }, commandOptions);
      changes = typeof response.n === 'number' ? response.n : 0;
      result = documentsResult([response]);
    }
    return { results: [result], changes, elapsed: Math.round(performance.now() - started) };
    } finally { if (this.activeQueryId === queryId) { this.activeQueryId = null; this.queryAbort = null; } }
  }
  close() { this.alive = false; this.client.close().catch(() => {}); }
}
module.exports = { MongoDBAdapter, parseCommand, documentsResult };
