const mysql = require('mysql2');

// Local protocol fixture, not a SQL engine. Never contacts a real database.
async function startMySQLFixture({ denyCancel = false, cancelDelayMs = 0 } = {}) {
  const sockets = new Set();
  const handshakes = [];
  const queries = [];
  const byId = new Map(); let nextId = 1;
  let revision = 0;
  let notesColumn = false;
  let autoIncrement = 3;
  const definitions=new Map([
    ['view:vista','CREATE ALGORITHM=UNDEFINED DEFINER=`fixture`@`localhost` SQL SECURITY DEFINER VIEW `test`.`vista` AS SELECT id,nombre FROM proyectos'],
    ['procedure:actualizar','CREATE DEFINER=`fixture`@`localhost` PROCEDURE `test`.`actualizar`() BEGIN SELECT 1; END'],
    ['function:calcular','CREATE DEFINER=`fixture`@`localhost` FUNCTION `test`.`calcular`(n int) RETURNS int DETERMINISTIC RETURN n+1']
  ]);
  const triggers = new Map([['audit_proyectos', { name: 'audit_proyectos', timing: 'BEFORE', event: 'INSERT', table: 'proyectos', body: 'SET NEW.nombre = TRIM(NEW.nombre)', definer: 'fixture@localhost' }]]);
  const triggerSQL = item => `CREATE DEFINER=\`fixture\`@\`localhost\` TRIGGER \`test\`.\`${item.name}\`\n${item.timing} ${item.event} ON \`test\`.\`${item.table}\`\nFOR EACH ROW\n${item.body};`;
  const tableDDL = () => "CREATE TABLE `proyectos` (\n  `id` int unsigned NOT NULL AUTO_INCREMENT,\n  `nombre` varchar(255) NOT NULL DEFAULT '' COMMENT 'Título'" + (notesColumn ? ",\n  `notas` text NULL" : '') + " ,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=" + autoIncrement + " DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Proyecto " + revision + "'";
  const server = mysql.createServer(connection => {
    const connectionId = nextId++; byId.set(connectionId, connection);
    let selectedDatabase = '';
    let sqlMode = 'STRICT_TRANS_TABLES';
    // mysql2's minimal server keeps one handshake command for all requests.
    // Reset its packet counter when a new client command starts.
    const handlePacket = connection.handlePacket.bind(connection);
    connection.handlePacket = packet => {
      if (connection.clientHelloReply && packet?.sequenceId === 0) connection.sequenceId = 0;
      return handlePacket(packet);
    };
    sockets.add(connection);
    connection.on('error', () => {});
    connection.stream.on('close', () => { sockets.delete(connection); byId.delete(connectionId); });
    connection.serverHandshake({
      protocolVersion: 10, serverVersion: '8.0.0-lqtac-fixture', connectionId,
      statusFlags: 2, characterSet: 45,
      capabilityFlags: 0x00000200 | 0x00008000 | 0x00080000 | 0x00000008,
      authCallback: (data, callback) => {
        selectedDatabase = data.database || '';
        handshakes.push({ user: data.user, database: data.database, hasToken: data.authToken.length > 0 });
        callback(null, data.user === 'denied' ? { code: 1045, message: 'Fixture access denied' } : null);
      }
    });
    function result(names, rows) {
      connection.writeColumns(names.map(name => ({ catalog: 'def', schema: 'test', table: '', orgTable: '', name, orgName: name, characterSet: 45, columnLength: 255, columnType: mysql.Types.VAR_STRING, flags: 0, decimals: 0 })));
      for (const row of rows) connection.writeTextRow(row);
      connection.writeEof(0, 2);
    }
    connection.on('stmt_prepare', sql => {
      queries.push(sql);
      const match = /^SET SESSION sql_mode = '(.*)'$/.exec(sql);
      if (match) { sqlMode = match[1]; connection.writeOk({ serverStatus: 2 }); }
      else connection.writeError({ code: 1064, message: 'Fixture unsupported SET' });
    });
    connection.on('query', sql => {
      queries.push(sql);
      if (/^KILL QUERY \d+$/.test(sql)) {
        if (denyCancel) { connection.writeError({ code: 1227, message: 'Fixture cancellation denied' }); return; }
        const target = byId.get(Number(sql.slice(11)));
        if (target?.pendingQuery) {
          const token = target.pendingQuery;
          const interrupt = () => { if (target.pendingQuery === token && !target.stream.destroyed) { target.pendingQuery = null; target.writeError({ code: 1317, message: 'Query execution was interrupted' }); } };
          if (cancelDelayMs) setTimeout(interrupt, cancelDelayMs).unref(); else interrupt();
        }
        connection.writeOk({ serverStatus: 2 }); return;
      }
      if(/^SHOW CREATE (VIEW|PROCEDURE|FUNCTION) /.test(sql)){
        const kind=/^SHOW CREATE (VIEW|PROCEDURE|FUNCTION)/.exec(sql)[1].toLowerCase();const name=/\.`([^`]+)`/.exec(sql)?.[1];const ddl=definitions.get(kind+':'+name);
        if(!ddl)connection.writeError({code:1305,message:'Object does not exist'});else if(kind==='view')result(['View','Create View','character_set_client','collation_connection'],[[name,ddl,'utf8mb4','utf8mb4_general_ci']]);else result([kind,'sql_mode','Create '+kind[0].toUpperCase()+kind.slice(1),'character_set_client','collation_connection'],[[name,'STRICT_TRANS_TABLES',ddl,'utf8mb4','utf8mb4_general_ci']]);
      }
      else if(/^CREATE[\s\S]*?\b(VIEW|PROCEDURE|FUNCTION) `test`\.`/.test(sql)){
        if(sql.includes('INVALID_BODY')){connection.writeError({code:1064,message:'Invalid object body'});return;}
        const match=/\b(VIEW|PROCEDURE|FUNCTION) `test`\.`([^`]+)`/.exec(sql);definitions.set(match[1].toLowerCase()+':'+match[2],sql);connection.writeOk({serverStatus:2});
      }
      else if(/^DROP (VIEW|PROCEDURE|FUNCTION) /.test(sql)){const match=/^DROP (VIEW|PROCEDURE|FUNCTION) `test`\.`([^`]+)`/.exec(sql);definitions.delete(match[1].toLowerCase()+':'+match[2]);connection.writeOk({serverStatus:2});}
      else if(sql.includes('FROM mysql.procs_priv'))result(['User','Host','Proc_priv'],[['fixture','localhost','Execute,Alter Routine']]);
      else if(sql.includes('information_schema.COLUMNS'))result(['COLUMN_NAME','COLUMN_TYPE'],[['id','int'],['nombre','varchar(255)']]);
      else if (sql.startsWith('SHOW CREATE TRIGGER ')) {
        const name = /\.`([^`]+)`/.exec(sql)?.[1]; const trigger = triggers.get(name);
        if (!trigger) connection.writeError({ code: 1360, message: 'Trigger does not exist' });
        else result(['Trigger', 'sql_mode', 'SQL Original Statement', 'character_set_client', 'collation_connection'], [[name, 'STRICT_TRANS_TABLES', triggerSQL(trigger), 'utf8mb4', 'utf8mb4_general_ci']]);
      }
      else if (/^CREATE(?: DEFINER=[\s\S]*?)? TRIGGER /.test(sql)) {
        if (sql.includes('INVALID_BODY')) { connection.writeError({ code: 1064, message: 'Fixture invalid trigger body' }); return; }
        const match = /TRIGGER `([^`]+)`\.`([^`]+)`\s+(BEFORE|AFTER) (INSERT|UPDATE|DELETE) ON `[^`]+`\.`([^`]+)`[\s\S]*?FOR EACH ROW(?: (?:FOLLOWS|PRECEDES) `[^`]+`)?\s*([\s\S]*);$/.exec(sql);
        if (!match) { connection.writeError({ code: 1064, message: 'Fixture invalid trigger SQL' }); return; }
        if (triggers.has(match[2])) { connection.writeError({ code: 1359, message: 'Trigger already exists' }); return; }
        triggers.set(match[2], { name: match[2], timing: match[3], event: match[4], table: match[5], body: match[6].trim(), definer: 'fixture@localhost' }); connection.writeOk({ serverStatus: 2 });
      }
      else if (sql.startsWith('DROP TRIGGER ')) { triggers.delete(/\.`([^`]+)`/.exec(sql)?.[1]); connection.writeOk({ serverStatus: 2 }); }
      else if (sql.startsWith('SELECT CURRENT_USER()')) result(['current_user'], [['fixture@localhost']]);
      else if (sql.startsWith('SHOW CREATE TABLE ')) result(['Table', 'Create Table'], [['proyectos', tableDDL()]]);
      else if (sql.startsWith('SHOW FULL COLUMNS FROM ')) result(['Field', 'Type', 'Collation', 'Null', 'Key', 'Default', 'Extra', 'Privileges', 'Comment'], [
        ['id', 'int unsigned', null, 'NO', 'PRI', null, 'auto_increment', '', ''],
        ['nombre', 'varchar(255)', 'utf8mb4_general_ci', 'NO', '', '', '', '', 'Título'],
        ...(notesColumn ? [['notas', 'text', 'utf8mb4_general_ci', 'YES', '', null, '', '', '']] : [])
      ]);
      else if (sql.startsWith('SHOW INDEX FROM ')) result(['Key_name', 'Non_unique', 'Seq_in_index', 'Column_name', 'Sub_part', 'Collation', 'Index_type', 'Index_comment', 'Visible'], [['PRIMARY', '0', '1', 'id', null, 'A', 'BTREE', '', 'YES']]);
      else if (sql.startsWith('SELECT @@SESSION.sql_mode')) result(['sql_mode', sql.includes('collation_connection') ? 'collation_connection' : 'version'], [[sqlMode, sql.includes('collation_connection') ? 'utf8mb4_general_ci' : '8.0.0-lqtac-fixture']]);
      else if (sql.startsWith('SELECT ENGINE, TABLE_COLLATION')) result(['ENGINE', 'TABLE_COLLATION', 'TABLE_COMMENT'], [['InnoDB', 'utf8mb4_general_ci', `Proyecto ${revision}`]]);
      else if (sql.includes('information_schema.KEY_COLUMN_USAGE')) result(['CONSTRAINT_NAME', 'COLUMN_NAME', 'REFERENCED_TABLE_SCHEMA', 'REFERENCED_TABLE_NAME', 'REFERENCED_COLUMN_NAME', 'UPDATE_RULE', 'DELETE_RULE'], []);
      else if (sql.includes('information_schema.TRIGGERS')) {
        if (sql.includes('ACTION_ORDER')) result(['TRIGGER_NAME', 'ACTION_ORDER'], [...triggers.values()].map((item, index) => [item.name, String(index + 1)]));
        else if (sql.includes('EVENT_OBJECT_TABLE, ACTION_TIMING')) result(['TRIGGER_NAME', 'EVENT_OBJECT_TABLE', 'ACTION_TIMING', 'EVENT_MANIPULATION', 'ACTION_STATEMENT', 'DEFINER'], [...triggers.values()].map(item => [item.name, item.table, item.timing, item.event, item.body, item.definer]));
        else result(['TRIGGER_NAME', 'ACTION_TIMING', 'EVENT_MANIPULATION', 'ACTION_STATEMENT'], [...triggers.values()].map(item => [item.name, item.timing, item.event, item.body]));
      }
      else if (sql.startsWith('ALTER TABLE ')) { if (sql.includes('ADD COLUMN `notas`')) notesColumn = true; revision++; connection.writeOk({ serverStatus: 2 }); }
      else if (sql.startsWith('CREATE TABLE ')) connection.writeOk({ serverStatus: 2 });
      else if (sql === 'SHOW DATABASES') result(['Database'], [['asterisk'], ['test'], ['sys']]);
      else if (sql.includes('information_schema.TABLES') && sql.includes('TABLE_SCHEMA,')) {
        result(['TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE'], [
          ['test', 'proyectos', 'BASE TABLE'], ['test', 'vista', 'VIEW'], ['asterisk', 'proyectos', 'BASE TABLE'],
          ...Array.from({ length: 1100 }, (_, i) => ['asterisk', `tabla_${i}`, 'BASE TABLE'])
        ]);
      }
      else if (sql.includes('information_schema.ROUTINES')) result(['ROUTINE_SCHEMA', 'ROUTINE_NAME', 'ROUTINE_TYPE'], [['test', 'actualizar', 'PROCEDURE'], ['test', 'calcular', 'FUNCTION']]);
      else if (sql.includes('information_schema.TABLES')) result(['TABLE_NAME', 'TABLE_TYPE'], [['proyectos', 'BASE TABLE'], ['vista', 'VIEW']]);
      else if (sql === 'SELECT DATABASE()') result(['DATABASE()'], [[selectedDatabase || null]]);
      else if (sql.startsWith('USE ')) { selectedDatabase = sql.slice(4).replace(/^`|`$/g, '').replaceAll('``', '`'); connection.writeOk({ serverStatus: 2 }); }
      else if (sql === 'SELECT many') result(['n'], Array.from({ length: 1200 }, (_, i) => [String(i)]));
      else if (sql === 'SELECT CONNECTION_ID()') result(['CONNECTION_ID()'], [[String(connectionId)]]);
      else if (/^SELECT wait_forever;?$/.test(sql)) { connection.pendingQuery = {}; }
      else if (sql === 'SELECT broken') connection.writeError({ code: 1064, message: 'Fixture syntax error' });
      else if (sql === 'SELECT unicode') result(['nombre', 'vacio'], [['Diseño LQTAC', null]]);
      else if (sql.includes('DATABASE()')) result(['base_de_datos', 'version_servidor'], [[selectedDatabase || null, '8.0.0-lqtac-fixture']]);
      else if (sql.startsWith('UPDATE')) connection.writeOk({ affectedRows: 2, serverStatus: 2 });
      else result(['1'], [['1']]);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = { name: 'Servidor de prueba', engine: 'mysql', host: '127.0.0.1', port: server._server.address().port, username: 'fixture', database: 'test' };
  return { profile, handshakes, queries, allowCancellation: () => { denyCancel = false; }, changeDefinition: () => { revision++; }, simulateInsert: () => { autoIncrement++; }, close: () => new Promise(resolve => { for (const socket of sockets) socket.stream.destroy(); server.close(resolve); }) };
}
module.exports = { startMySQLFixture };
