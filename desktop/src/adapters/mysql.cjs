const mysql = require('mysql2');

function connectionError(error) {
  const messages = {
    ER_ACCESS_DENIED_ERROR: 'Acceso denegado. Comprueba el usuario, la contraseña y sus permisos desde este equipo.',
    ER_BAD_DB_ERROR: 'La base de datos no existe en el servidor.',
    ER_NO_DB_ERROR: 'No hay una base seleccionada. Elige la base de la consulta en el selector o configura la base predeterminada del perfil.',
    ER_DBACCESS_DENIED_ERROR: 'El usuario no tiene acceso a esta base de datos.',
    ECONNREFUSED: 'El servidor rechazó la conexión. Comprueba el puerto y que MySQL esté activo.',
    ETIMEDOUT: 'Tiempo de conexión agotado. Comprueba la red, la VPN y el firewall.',
    ENOTFOUND: 'No se encontró el servidor. Comprueba su nombre o dirección.',
    EHOSTUNREACH: 'No hay ruta al servidor. Comprueba la red o la VPN.',
    PROTOCOL_CONNECTION_LOST: 'Se ha perdido la conexión con el servidor. Vuelve a conectar.',
    PROTOCOL_SEQUENCE_TIMEOUT: 'La consulta superó los 30 segundos. Vuelve a conectar si la sesión se ha cerrado.'
  };
  return new Error(messages[error.code] ?? error.message ?? 'No se pudo completar la operación MySQL.');
}

class MySQLAdapter {
  static async open(profile, password, options = {}) {
    const connection = mysql.createConnection({
      host: profile.host, port: profile.port, user: profile.username,
      password, database: profile.database || undefined, connectTimeout: 10000,
      multipleStatements: false, rowsAsArray: true,
      supportBigNumbers: true, bigNumberStrings: true, dateStrings: true,
      ...(options.charset ? { charset: options.charset } : {}),
      ...(profile.tls ? { ssl: { rejectUnauthorized: true } } : {})
    });
    const adapter = new MySQLAdapter(connection, profile);
    try {
      await new Promise((resolve, reject) => connection.connect(error => error ? reject(error) : resolve()));
      return adapter;
    } catch (error) { adapter.close(); throw connectionError(error); }
  }

  constructor(connection, profile) {
    this.connection = connection;
    this.profile = profile;
    this.alive = true;
    connection.on('error', () => { this.alive = false; });
  }

  async schema() {
    try {
      const [rows] = await this.connection.promise().query({ sql: 'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME', timeout: 30000 });
      return rows.map(([name, type]) => ({ name, type: type === 'VIEW' ? 'view' : 'table' }));
    } catch (error) { throw connectionError(error); }
  }

  async currentDatabase() {
    const [rows] = await this.connection.promise().query({ sql: 'SELECT DATABASE()', timeout: 30000 });
    return rows[0]?.[0] ?? '';
  }

  async catalog() {
    try {
      const database = await this.currentDatabase();
      const [names] = await this.connection.promise().query({ sql: 'SHOW DATABASES', timeout: 30000 });
      const schemas = names.map(([name]) => ({ name, objects: [] }));
      const byName = new Map(schemas.map(schema => [schema.name, schema]));
      const [tables] = await this.connection.promise().query({ sql: 'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME', timeout: 30000 });
      for (const [schema, name, type] of tables) byName.get(schema)?.objects.push({ name, type: type === 'VIEW' ? 'view' : 'table' });
      let warning;
      try {
        const [routines] = await this.connection.promise().query({ sql: 'SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME', timeout: 30000 });
        for (const [schema, name, type] of routines) byName.get(schema)?.objects.push({ name, type: type === 'FUNCTION' ? 'function' : 'procedure' });
      } catch { warning = 'No se pudieron consultar las rutinas. Las tablas y vistas sí están disponibles.'; }
      return { database, schemas, warning };
    } catch (error) { throw connectionError(error); }
  }

  async selectDatabase(name) {
    if (typeof name !== 'string' || !name || name.length > 255) throw new Error('Nombre de base de datos no válido.');
    try { await this.connection.promise().query({ sql: 'USE ' + mysql.escapeId(name), timeout: 30000 }); }
    catch (error) { throw connectionError(error); }
  }

  async execute(sql) {
    if (!this.alive) throw new Error('La sesión está cerrada. Vuelve a conectar.');
    if (typeof sql !== 'string' || !sql.trim()) throw new Error('Escribe una consulta SQL.');
    if (sql.length > 1_000_000) throw new Error('La consulta supera el tamaño permitido.');
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const results = [];
      let currentResult;
      let changes = 0;
      // Consume the full protocol response but retain at most 1,000 rows.
      this.connection.query({ sql, timeout: 30000 })
        .on('fields', fields => {
          currentResult = fields?.length ? { columns: fields.map(field => field.name), values: [], truncated: false } : null;
          if (currentResult) results.push(currentResult);
        })
        .on('result', row => {
          if (!Array.isArray(row)) { changes = row.affectedRows ?? 0; return; }
          if (!currentResult) return;
          if (currentResult.values.length >= 1000) { currentResult.truncated = true; return; }
          currentResult.values.push(row.map(value => Buffer.isBuffer(value) ? `[BLOB ${value.length} bytes]` : value !== null && typeof value === 'object' ? JSON.stringify(value) : value));
        })
        .on('error', error => {
          if (error.code === 'PROTOCOL_SEQUENCE_TIMEOUT') this.close();
          reject(connectionError(error));
        })
        .on('end', () => resolve({ results, changes, elapsed: Math.round(performance.now() - started) }));
    });
  }

  close() { this.alive = false; this.connection.destroy(); this.connection.stream.destroy(); }
}
module.exports = { MySQLAdapter, connectionError };
