const { app, BrowserWindow, dialog, ipcMain, Menu, session, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
// Configure Chromium storage before ready so the entire workspace travels with the portable folder.
if (app.isPackaged && require('node:fs').existsSync(path.join(path.dirname(process.execPath), 'portable.json'))) {
  const portableData = path.join(path.dirname(process.execPath), 'Data');
  try {
    require('node:fs').mkdirSync(portableData, { recursive: true });
    require('node:fs').accessSync(portableData, require('node:fs').constants.W_OK);
    app.setPath('userData', portableData);
    app.setPath('sessionData', portableData);
    app.setAppLogsPath(path.join(portableData, 'logs'));
  } catch (error) {
    dialog.showErrorBox('LQTAC Data Base portable', 'No se puede escribir en la carpeta Data. Mueve la aplicación a una carpeta con permiso de escritura.\n' + error.message);
    app.exit(1);
  }
}
const { pathToFileURL } = require('node:url');
const { SQLiteAdapter } = require('./adapters/sqlite.cjs');
const { ConnectionStore } = require('./connections.cjs');
const { MySQLAdapter } = require('./adapters/mysql.cjs');
const { ClickHouseAdapter } = require('./adapters/clickhouse.cjs');
const { MongoDBAdapter } = require('./adapters/mongodb.cjs');
const { PostgreSQLAdapter } = require('./adapters/postgresql.cjs');
const { SQLServerAdapter } = require('./adapters/sqlserver.cjs');
const { OracleAdapter } = require('./adapters/oracle.cjs');
const { formatQuery, visibleResults, exportResult, exportRows, readRelations } = require('./query-tools.cjs');
const {readColumns}=require('./column-metadata.cjs');
const {inspectObject,buildObjectPlan,routineGrants,applyObject}=require('./object-editor.cjs');
const {canRestoreDefiner}=require('./mysql-trigger.cjs');
const {SQLFiles}=require('./sql-files.cjs');
const {restoreQueryContext}=require('./query-context.cjs');
const {createHash}=require('node:crypto');
const {planExecution}=require('./sql-statements.cjs');
const {SettingsStore,executeTimed}=require('./settings.cjs');
const {ResultEdits,decorateResult}=require('./result-edit.cjs');
const {refreshBoard}=require('./dashboard-refresh.cjs');
const {exportPackage,parsePackage,importPackage}=require('./dashboard-transfer.cjs');
const {QueryResponses}=require('./query-responses.cjs');
const {DashboardStore,snapshotDatasets,DashboardQueryCache}=require('./dashboards.cjs');
const { inspectTable, buildTablePlan } = require('./mysql-table.cjs');
const { randomUUID } = require('node:crypto');
const { inspectTrigger, createTriggerSQL, replaceTrigger } = require('./mysql-trigger.cjs');
const { literal, identifier } = require('./mysql-table.cjs');

let window;
let adapter;
let currentName = '';
let currentEngine = 'sqlite';
let currentProfileId = null;
let cachedObjects = [];
let cachedSchemas = [];
let currentDatabase = '';
let databaseBusy = false;
const tablePlans = new Map();
const sessions = new Map();
let exportSnapshot;
let activeExecution = null;
const authentication=new WeakMap();
const drivers={mysql:MySQLAdapter,mariadb:MySQLAdapter,clickhouse:ClickHouseAdapter,mongodb:MongoDBAdapter,postgresql:PostgreSQLAdapter,sqlserver:SQLServerAdapter,oracle:OracleAdapter};
const entry = path.join(__dirname, 'renderer', 'index.html');

function register(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame?.url !== pathToFileURL(entry).href) {
      throw new Error('Origen no permitido.');
    }
    return handler(...args);
  });
}

function rememberActive() {
  if (adapter) sessions.set(currentProfileId || 'local', { adapter, name: currentName, engine: currentEngine, profileId: currentProfileId, objects: cachedObjects, schemas: cachedSchemas, database: currentDatabase });
}
function sessionStatus(saved, key) {
  return { name: saved.name, engine: saved.engine, profileId: saved.profileId, sessionKey: key, connected: saved.adapter.alive !== false, queryPending:!!saved.adapter.pendingExecution, pendingRunId:saved.adapter.pendingExecution?.runId, objects: saved.objects, schemas: saved.schemas, database: saved.database, scope: saved.adapter.scope, databaseName: saved.adapter.databaseName,profileSignature:profileSignature(saved.adapter) };
}
function profileSignature(value){const profile=authentication.get(value)?.profile;return profile?createHash('sha256').update(JSON.stringify([profile.engine,profile.host,profile.port,profile.username,profile.database,profile.authSource,profile.tls])).digest('hex'):null;}
function databaseStatus() {
  rememberActive();
  return { name: currentName, engine: currentEngine, profileId: currentProfileId, sessionKey: adapter ? currentProfileId || 'local' : null, connected: !!adapter && adapter.alive !== false, queryPending:!!adapter?.pendingExecution, pendingRunId:adapter?.pendingExecution?.runId, objects: cachedObjects, schemas: cachedSchemas, database: currentDatabase, scope: adapter?.scope, databaseName: adapter?.databaseName,profileSignature:adapter?profileSignature(adapter):null };
}
function selectSession(key) {
  rememberActive();
  const saved = sessions.get(key);
  if (!saved || saved.adapter.alive === false) throw new Error('La conexión de esta consulta está cerrada. Conecta ese perfil antes de ejecutar.');
  adapter = saved.adapter; currentName = saved.name; currentEngine = saved.engine; currentProfileId = saved.profileId;
  cachedObjects = saved.objects; cachedSchemas = saved.schemas; currentDatabase = saved.database;
  return databaseStatus();
}
function closeSession(key) {
  rememberActive();
  const saved = sessions.get(key);
  if (!saved) return;
  for (const [id, plan] of tablePlans) if (plan.session === saved.adapter) tablePlans.delete(id);
  saved.adapter.close(); sessions.delete(key);
  if (adapter === saved.adapter) { adapter = null; currentName = ''; currentProfileId = null; cachedObjects = []; cachedSchemas = []; currentDatabase = ''; }
}
async function exclusive(action, { allowPending = false } = {}) {
  if (databaseBusy) throw new Error('Hay una operación en curso. Espera a que termine.');
  if (!allowPending && adapter?.pendingExecution) throw new Error('La consulta anterior aún está terminando en este servidor. Puedes usar otra conexión o reintentar Detener.');
  databaseBusy = true;
  try { return await action(); } finally { databaseBusy = false; }
}
async function activate(next, name, engine = 'sqlite', profileId = null) {
  let catalog;
  try { catalog = next.catalog ? await next.catalog() : { database: 'main', schemas: [{ name: 'main', objects: await next.schema() }] }; }
  catch (error) { next.close(); throw error; }
  rememberActive();
  const replaced = sessions.get(profileId || 'local');
  if (replaced && replaced.adapter !== next) closeSession(profileId || 'local');
  adapter = next; currentName = name;
  currentEngine = engine; currentProfileId = profileId;
  cachedSchemas = catalog.schemas; currentDatabase = catalog.database;
  cachedObjects = cachedSchemas.find(schema => schema.name === currentDatabase)?.objects ?? [];
  return { ...databaseStatus(), warning: catalog.warning };
}

if (process.platform === 'win32') app.setAppUserModelId('LQTAC.DataBase');
app.whenReady().then(() => {
  const settings = new SettingsStore(app.getPath('userData'));
  const dashboards = new DashboardStore(app.getPath('userData'));
  const dashboardQueries=new DashboardQueryCache(),queryResponses=new QueryResponses();
  const snapshotFor=token=>queryResponses.find(token)||(exportSnapshot?.token===token?exportSnapshot:null);
  register('results:rename',(token,index,name)=>{const snapshot=snapshotFor(token);if(!snapshot?.results[index]||!Number.isInteger(index)||typeof name!=='string'||!name.trim()||name.length>160)throw Error('El nombre de la respuesta no es válido.');const label=name.trim();snapshot.results[index].label=label;snapshot.results[index].customLabel=true;for(const {snapshot:cached}of dashboardQueries.entries.values())if(cached.token===token&&cached.results[index]){cached.results[index].label=label;cached.results[index].customLabel=true;}return label;});
  register('dashboards:delete',(id,revision)=>dashboards.remove(id,revision));
  register('dashboards:query-remember',(id,token)=>{if(!exportSnapshot||exportSnapshot.token!==token)throw Error('Los resultados han caducado.');queryResponses.remember(id,exportSnapshot);dashboardQueries.remember(id,exportSnapshot);});
  register('dashboards:query-forget',id=>{dashboardQueries.forget(id);const removed=queryResponses.forget(id);if(removed===exportSnapshot)exportSnapshot=null;for(const [token,item]of resultEdits.sessions)if(item.snapshot===removed)resultEdits.sessions.delete(token);});
  register('dashboards:queries',ids=>dashboardQueries.list(ids));
  register('dashboards:query-capture',requests=>dashboardQueries.capture(requests));
  let pendingDashboardImport=null;
  register('dashboards:export',async request=>{const board=request?.id?await dashboards.read(request.id):request?.board;const pkg=await exportPackage(board,app.getVersion());const name='LQTAC-'+pkg.board.name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')+'.lqtac-dashboard';const selected=await dialog.showSaveDialog(window,{title:'Exportar dashboard con sus datos y consultas',defaultPath:name,filters:[{name:'Dashboard LQTAC Data Base',extensions:['lqtac-dashboard']}]});if(selected.canceled)return null;await fs.writeFile(selected.filePath,JSON.stringify(pkg),{encoding:'utf8',mode:0o600});return {name:path.basename(selected.filePath)};});
  register('dashboards:import-prepare',async()=>{const selected=await dialog.showOpenDialog(window,{title:'Importar dashboard LQTAC Data Base',properties:['openFile'],filters:[{name:'Dashboard LQTAC Data Base',extensions:['lqtac-dashboard','json']}]});if(selected.canceled)return null;const file=selected.filePaths[0];if((await fs.stat(file)).size>24000000)throw Error('El archivo supera 24 MB.');const pkg=await parsePackage(await fs.readFile(file,'utf8')),token=randomUUID();pendingDashboardImport={token,pkg,expires:Date.now()+900000};return {token,name:pkg.board.name,datasets:pkg.board.datasets.length,widgets:pkg.board.widgets.length,connections:pkg.connections};});
  register('dashboards:import-cancel',token=>{if(pendingDashboardImport?.token===token)pendingDashboardImport=null;});
  register('dashboards:import-finish',async(token,options)=>{const pending=pendingDashboardImport;if(!pending||pending.token!==token||pending.expires<Date.now())throw Error('La importación ha caducado. Selecciona el archivo de nuevo.');if(pending.processing)throw Error('Esta importación ya está en curso.');pending.processing=true;try{const board=await importPackage(pending.pkg,options,await connections.list());const saved=await dashboards.save(board);if(pendingDashboardImport===pending)pendingDashboardImport=null;return {id:saved.id,name:saved.name};}finally{pending.processing=false;}});
  register('dashboards:list',()=>dashboards.list());
  register('dashboards:open',id=>dashboards.read(id));
  register('dashboards:save',board=>dashboards.save(board));
  register('dashboards:refresh',(board,ids)=>exclusive(async()=>{
    rememberActive();return refreshBoard(board,ids,async source=>{
      if(source.transferUnmapped)throw Error('Esta fuente importada no tiene un servidor local asociado. Importa el dashboard eligiendo su conexión para actualizarla.');
      const candidates=[...sessions.entries()].filter(([,session])=>session.name===source.connection&&session.engine===source.engine);const key=source.connectionKey|| (candidates.length===1?candidates[0][0]:null);const saved=sessions.get(key);if(!saved||saved.adapter.alive===false)throw Error('Conecta primero el servidor de esta fuente.');
      if(source.engine!==saved.engine)throw Error('El motor de la conexión ha cambiado.');
      if(source.profileSignature&&source.profileSignature!==profileSignature(saved.adapter))throw Error('La configuración del servidor ha cambiado. Vuelve a capturar la fuente.');
      const credentials=authentication.get(saved.adapter);let target=saved.adapter,owned=false;
      if(saved.engine!=='sqlite'){if(!credentials)throw Error('Conecta de nuevo para disponer de las credenciales de sesión.');target=await drivers[saved.engine].open(credentials.profile,credentials.password);owned=true;}
      try{if(owned){const catalog=await target.catalog();await restoreQueryContext(target,saved.engine,{database:source.database,databaseName:source.databaseName},catalog.schemas);}
        const limit=[0,50,100,500,1000].includes(source.rowLimit)?source.rowLimit:1000;
        if(owned){const readOnly={mysql:'START TRANSACTION READ ONLY',mariadb:'START TRANSACTION READ ONLY',postgresql:'BEGIN READ ONLY',oracle:'SET TRANSACTION READ ONLY'}[saved.engine];if(readOnly)await target.execute(readOnly);}
        const output=visibleResults(await executeTimed(target,saved.engine,source.sql,settings.get().queryTimeoutSeconds*1000,{rowLimit:limit,runId:randomUUID(),openControl:owned?()=>drivers[saved.engine].open(credentials.profile,credentials.password):controlFor(target)}),limit);
        const result=output.results[source.resultIndex||0];if(!result?.columns?.length||result.error)throw Error(result?.error||'La consulta no devolvió una tabla.');return {...result,sourceContext:{connectionKey:key,profileSignature:profileSignature(saved.adapter),databaseName:source.databaseName||target.databaseName,rowLimit:limit}};
      }finally{if(owned)target.close();}
    });
  },{allowPending:true}));
  register('dashboards:capture',(token,indices)=>snapshotDatasets(snapshotFor(token),token,indices));
  const resultEdits = new ResultEdits();
  register('results:edit-open',(token,index)=>exclusive(async()=>{const snapshot=snapshotFor(token);if(!snapshot||snapshot.session!==adapter||!Number.isInteger(index))throw new Error('El resultado ha caducado. Ejecuta de nuevo la consulta.');return resultEdits.open(snapshot,index,adapter,currentEngine,currentProfileId||'local');}));
  register('results:edit-apply',request=>exclusive(async()=>{
    const source=adapter,engine=currentEngine,key=currentProfileId||'local',runId='data-edit:'+randomUUID(),timeoutMs=settings.get().queryTimeoutSeconds*1000;
    const snapshot=resultEdits.sessions.get(request?.token)?.snapshot;if(!snapshot||snapshotFor(snapshot.token)!==snapshot)throw Error('El resultado ha caducado. Ejecuta de nuevo la consulta.');
    const result=await resultEdits.apply(request,snapshot,source,key,async(_item,write)=>executeTimed(source,engine,'Aplicar cambios de datos',timeoutMs,{openControl:controlFor(source),runId,onCancellationReleased:()=>window?.webContents.send('execution:released',{runId,key}),execute:async()=>{if(engine==='postgresql'){await source.client.query('SET statement_timeout TO '+timeoutMs);source.queryTimeoutMs=timeoutMs;}return write();}}),state=>{if(window&&!window.isDestroyed())window.webContents.send('results:edit-progress',{token:request.token,...state});});
    for(const [id,item]of [...dashboardQueries.entries])if(item.snapshot.token===snapshot.token){try{dashboardQueries.remember(id,snapshot);}catch{dashboardQueries.forget(id);}break;}
    return {...result,...databaseStatus()};
  }));
  register('settings:get', () => settings.get());
  register('settings:save', value => settings.save(value));
  register('database:cancel', (runId, key) => {
    if (typeof runId !== 'string' || typeof key !== 'string') throw new Error('Identificador de ejecución no válido.');
    const pending = sessions.get(key)?.adapter.pendingExecution;
    if (pending && pending.runId === runId) { pending.cancel(); return true; }
    if (!activeExecution || activeExecution.runId !== runId || activeExecution.key !== key || activeExecution.engine === 'sqlite') return false;
    if (activeExecution.controller.signal.aborted) activeExecution.controller.signal.dispatchEvent(new Event('cancel-request'));
    else activeExecution.controller.abort();
    return true;
  });
  const controlFor = target => async () => {
    const saved = authentication.get(target);
    if (!saved) throw new Error('No están disponibles las credenciales de esta sesión.');
    return drivers[saved.profile.engine].open(saved.profile, saved.password);
  };
  const connections = new ConnectionStore(app.getPath('userData'));
  const sqlFiles=new SQLFiles(app.getPath('userData'));
  register('sql:open',async()=>{const result=await dialog.showOpenDialog(window,{title:'Abrir archivo SQL',properties:['openFile'],filters:[{name:'Consultas SQL',extensions:['sql']},{name:'Texto',extensions:['txt']}]});return result.canceled?null:sqlFiles.open(result.filePaths[0]);});
  register('sql:save',request=>sqlFiles.save(request,async()=>{const result=await dialog.showSaveDialog(window,{title:'Guardar archivo SQL',defaultPath:'consulta.sql',filters:[{name:'Consultas SQL',extensions:['sql']}]});return result.canceled?null:result.filePath;}));
  register('clipboard:write',text=>{if(typeof text!=='string'||text.length>8000000)throw new Error('El contenido supera el límite de copia (8 millones de caracteres).');clipboard.writeText(text);return true;});
  register('connections:list', () => connections.list());
  register('connections:save', profile => connections.save(profile));
  register('connections:overview', async () => {
    rememberActive();
    return { profiles: await connections.list(), groups: await connections.groups(), sessions: [...sessions].map(([key, saved]) => sessionStatus(saved, key)), activeKey: adapter ? currentProfileId || 'local' : null };
  });
  register('connections:create-group', (name, ids) => connections.createGroup(name, ids));
  register('connections:move', (ids, groupId) => connections.move(ids, groupId));
  register('connections:ungroup', id => connections.ungroup(id));
  register('connections:activate', key => exclusive(async () => selectSession(key), {allowPending:true}));
  register('connections:disconnect', key => exclusive(async () => { closeSession(key); return databaseStatus(); }, {allowPending:true}));
  register('connections:remove', ids => exclusive(async () => {
    const removed = await connections.remove(ids);
    for (const id of removed) closeSession(id);
    return databaseStatus();
  }));
  async function openProfile(id, password) {
    const profile = (await connections.list()).find(item => item.id === id);
    if (!profile) throw new Error('No se encuentra el perfil de conexión.');
    const Driver = drivers[profile.engine];
    if (!Driver) throw new Error('Este motor todavía no tiene driver integrado.');
    if (typeof password !== 'string' || password.length > 4096) throw new Error('Contraseña no válida.');
    const next=await Driver.open(profile,password);authentication.set(next,{profile,password});return {profile,next};
  }
  register('connections:connect', (id, password) => exclusive(async () => {
    rememberActive();
    if (sessions.get(id)?.adapter.alive !== false && sessions.has(id)) return selectSession(id);
    const { profile, next } = await openProfile(id, password);
    return activate(next, profile.name, profile.engine, profile.id);
  }, {allowPending:true}));
  register('connections:test', async (id, password) => {
    const { next } = await openProfile(id, password);
    try { await next.execute(next instanceof MongoDBAdapter ? '{"ping":1}' : next instanceof OracleAdapter ? 'SELECT 1 FROM DUAL' : 'SELECT 1'); return true; } finally { next.close(); }
  });
  register('database:disconnect', () => exclusive(async () => {
    if (adapter) closeSession(currentProfileId || 'local');
    return databaseStatus();
  }));
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  register('database:demo', () => exclusive(async () => {
    const next = await SQLiteAdapter.open();
    next.execute(`CREATE TABLE proyectos (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, estado TEXT, motor TEXT);
      INSERT INTO proyectos VALUES (1, 'LQTAC Data Base', 'En desarrollo', 'SQLite'), (2, 'Inventario', 'Activo', 'PostgreSQL'), (3, 'Operaciones', 'Activo', 'MySQL');
      CREATE TABLE tareas (id INTEGER PRIMARY KEY, proyecto_id INTEGER REFERENCES proyectos(id), titulo TEXT, completada INTEGER DEFAULT 0);
      INSERT INTO tareas VALUES (1, 1, 'Diseñar el espacio de trabajo', 1), (2, 1, 'Integrar el núcleo JDBC', 0);`);
    return activate(next, 'Laboratorio LQTAC');
  }));
  register('database:open', () => exclusive(async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Abrir base SQLite (copia en memoria)', properties: ['openFile'], filters: [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] }, { name: 'Todos los archivos', extensions: ['*'] }] });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    const stat = await fs.stat(file);
    if (stat.size > 100 * 1024 * 1024) throw new Error('Esta versión admite archivos de hasta 100 MB.');
    return activate(await SQLiteAdapter.fromBytes(await fs.readFile(file)), path.basename(file));
  }));
  register('query:format', (source,engine) => formatQuery(source,engine));
  register('database:columns',(tables,key)=>exclusive(async()=>{if(!adapter||key!==(currentProfileId||'local'))throw new Error('La conexión de las columnas ha cambiado.');return readColumns(adapter,currentEngine,tables,cachedSchemas);}));
  register('database:context',(key,context)=>exclusive(async()=>{if(!adapter||key!==(currentProfileId||'local'))throw new Error('La conexión de esta consulta ha cambiado.');if(adapter.pendingExecution)return databaseStatus();const catalog=await restoreQueryContext(adapter,currentEngine,context,cachedSchemas);if(catalog)cachedSchemas=catalog.schemas;currentDatabase=await adapter.currentDatabase?.()||currentDatabase;cachedObjects=cachedSchemas.find(item=>item.name===currentDatabase)?.objects||[];return databaseStatus();},{allowPending:true}));
  function objectTarget(target,key){
    if(!adapter||adapter.alive===false||key!==(currentProfileId||'local'))throw new Error('La conexión del objeto ha cambiado.');
    if(!target||!['view','procedure','function'].includes(target.type))throw new Error('Selecciona una vista o rutina.');
    const object=cachedSchemas.find(item=>item.name===target.schema)?.objects.find(item=>item.name===target.name&&item.type===target.type&&(!target.oid||String(item.oid)===String(target.oid)));
    if(!object)throw new Error('El objeto no está en el catálogo visible. Recarga el explorador.');
    return {schema:target.schema,name:object.name,type:object.type,oid:object.oid||null};
  }
  register('object:inspect',(target,key)=>exclusive(async()=>inspectObject(adapter,currentEngine,objectTarget(target,key))));
  register('object:preview',(request,key)=>exclusive(async()=>{
    const target=objectTarget(request?.target,key);const original=await inspectObject(adapter,currentEngine,target);
    if(original.version!==request.version)throw new Error('La definición ha cambiado. Recarga antes de revisar.');
    const plan=buildObjectPlan(original,request.sql);
    if(plan.drop&&['mysql','mariadb'].includes(currentEngine)){if(!original.definer)throw new Error('No se pudo verificar el DEFINER original.');await canRestoreDefiner(adapter,original);plan.grants=await routineGrants(adapter,original);if(plan.grants===null)plan.warnings.push('No se han podido leer los permisos de otras cuentas. Revisa esos permisos tras recrear la rutina.');else if(plan.grants.length)plan.sql+=';\n\n'+plan.grants.join(';\n')+';';}
    for(const [id,item] of tablePlans)if(item.expires<Date.now())tablePlans.delete(id);if(tablePlans.size>=20)tablePlans.delete(tablePlans.keys().next().value);
    const token=randomUUID();tablePlans.set(token,{kind:'object',session:adapter,engine:currentEngine,original,plan,target,expires:Date.now()+600000});return {token,sql:plan.sql,warnings:plan.warnings};
  }));
  register('object:apply',(token,key)=>exclusive(async()=>{
    const item=tablePlans.get(token);if(!item||item.kind!=='object'||item.expires<Date.now()||item.session!==adapter)throw new Error('La revisión ha caducado o la conexión ha cambiado.');
    objectTarget(item.target,key);const latest=await inspectObject(adapter,item.engine,item.target);if(latest.version!==item.original.version)throw new Error('El objeto ha cambiado desde la revisión. No se ha modificado.');
    let worker=adapter;
    if(item.engine!=='sqlite'){
      const auth=authentication.get(adapter);if(!auth)throw new Error('Reconecta para editar la definición.');
      const profile={...auth.profile};if(['mysql','mariadb','clickhouse','mongodb'].includes(item.engine))profile.database=item.original.schema;if(item.engine==='sqlserver')profile.database=item.original.databaseName;
      worker=await drivers[item.engine].open(profile,auth.password,['mysql','mariadb'].includes(item.engine)?{charset:item.original.collation||undefined}:undefined);
    }
    try{
      if(['mysql','mariadb'].includes(item.engine)){await worker.execute('SET SESSION sql_mode = '+literal(item.original.sqlMode||''));if(item.plan.drop)await canRestoreDefiner(worker,item.original);}
      if(item.engine==='postgresql')await worker.client.query('SELECT set_config(\'search_path\',$1,false)',[item.original.searchPath]);
      if(item.engine==='sqlserver')await worker.execute(`SET ANSI_NULLS ${item.original.ansiNulls?'ON':'OFF'}; SET QUOTED_IDENTIFIER ${item.original.quotedIdentifier?'ON':'OFF'};`);
      const check=await inspectObject(worker,item.engine,item.target);if(check.version!==item.original.version)throw new Error('El objeto ha cambiado antes de aplicar. No se ha modificado.');
      if(item.plan.drop&&['mysql','mariadb'].includes(item.engine)&&JSON.stringify(await routineGrants(worker,item.original))!==JSON.stringify(item.plan.grants))throw new Error('Los permisos de la rutina han cambiado. Revisa de nuevo antes de aplicar.');
      const directory=path.join(app.getPath('userData'),'object-backups');await fs.mkdir(directory,{recursive:true});const backupPath=path.join(directory,token+'.json');await fs.writeFile(backupPath,JSON.stringify({original:item.original,restoreSQL:item.original.ddl,grants:item.plan.grants,savedAt:new Date().toISOString()},null,2),{mode:0o600});
      tablePlans.delete(token);const result=await applyObject(worker,item.original,item.plan);let object=null;try{object=await inspectObject(worker,item.engine,item.target);}catch{/* Preserve the outcome even when the new definition cannot be read. */}
      return {...result,object,backupPath};
    }finally{if(worker!==adapter)worker.close();}
  }));
  register('database:relations', (schema,expectedSession) => exclusive(async()=>{
    if(!adapter || expectedSession!==(currentProfileId||'local')) throw new Error('Selecciona la conexión del diagrama.');
    if(!cachedSchemas.some(item=>item.name===schema))throw new Error('Selecciona una base o esquema visible.');
    return readRelations(adapter,currentEngine,schema,cachedSchemas);
  }));
  register('results:export',async(token,index,format,indices)=>{
    const snapshot=snapshotFor(token);if(!snapshot || !Number.isInteger(index) || !snapshot.results[index]?.columns?.length)throw new Error('Elige un resultado con columnas para exportar.');
    if(!['csv','xlsx'].includes(format))throw new Error('Formato no válido.');
    const result=exportRows(snapshot.results[index],indices);
    const selected=await dialog.showSaveDialog(window,{title:'Exportar resultado visible',defaultPath:`resultado.${format}`,filters:[{name:format.toUpperCase(),extensions:[format]}]});
    if(selected.canceled)return false;
    await fs.writeFile(selected.filePath,await exportResult(result,format));return true;
  });
  register('database:execute', (sql, expectedSession, limit=1000,context) => exclusive(async () => {
    const timeoutMs = settings.get().queryTimeoutSeconds * 1000;
    if(![0,50,100,500,1000].includes(limit))throw new Error('Selecciona un límite válido.');
    exportSnapshot=null;
    if (!adapter) throw new Error('Abre una base de datos primero.');
    if (expectedSession && expectedSession !== (currentProfileId || 'local')) throw new Error('La conexión activa no corresponde a esta consulta. Selecciona su conexión antes de ejecutar.');
    const restored=await restoreQueryContext(adapter,currentEngine,context,cachedSchemas);if(restored)cachedSchemas=restored.schemas;
    currentDatabase=await adapter.currentDatabase?.()||currentDatabase;
    const output = visibleResults(await executeTimed(adapter,currentEngine,sql,timeoutMs,{openControl:controlFor(adapter),rowLimit:limit}),limit);
    if(output.results.length===1)decorateResult(output.results[0],{sql,engine:currentEngine,database:currentDatabase||'main',adapter});
    output.results.forEach((r,i)=>{r.label ||= 'Respuesta '+(i+1);});
    const exportToken=randomUUID();exportSnapshot={token:exportToken,results:output.results,session:adapter,sql,source:{connection:currentName,connectionKey:currentProfileId||'local',profileSignature:profileSignature(adapter),engine:currentEngine,database:currentDatabase,databaseName:adapter?.databaseName,rowLimit:limit}};
    let warning;
    try {
      if (currentEngine === 'sqlite') {
        cachedObjects = await adapter.schema(); cachedSchemas = [{ name: 'main', objects: cachedObjects }];
      } else {
        if (adapter.catalogDirty) { const catalog = await adapter.catalog(); cachedSchemas = catalog.schemas; }
        currentDatabase = await adapter.currentDatabase();
        cachedObjects = cachedSchemas.find(schema => schema.name === currentDatabase)?.objects ?? [];
      }
    } catch { warning = 'Consulta completada; no se pudo actualizar el explorador.'; }
    return { ...output, ...databaseStatus(), warning,exportToken };
  }));
  register('query:plan',(source,options,key)=>exclusive(async()=>{
    if(!adapter||key!==(currentProfileId||'local'))throw new Error('La conexión de la consulta ha cambiado.');let mode='';
    if(['mysql','mariadb'].includes(currentEngine)){const [rows]=await adapter.connection.promise().query('SELECT @@SESSION.sql_mode AS sql_mode');mode=rows[0][0]||'';}
    return planExecution(source,options,currentEngine,mode);
  }));
  register('database:batch',(statements,key,limit=1000,context,runId)=>exclusive(async()=>{
    const timeoutMs = settings.get().queryTimeoutSeconds * 1000;
    if(!adapter||key!==(currentProfileId||'local'))throw new Error('La conexión de la consulta ha cambiado.');
    if(!Array.isArray(statements)||!statements.length||statements.length>100||statements.some(sql=>typeof sql!=='string'||!sql.trim())||statements.reduce((sum,sql)=>sum+sql.length,0)>1000000)throw new Error('El lanzamiento supera 100 sentencias o un millón de caracteres.');
    if(![0,50,100,500,1000].includes(limit)||typeof runId!=='string'||runId.length>100)throw new Error('Opciones de ejecución no válidas.');
    const execution = {runId,key,engine:currentEngine,controller:new AbortController()}; activeExecution = execution;
    try {
    exportSnapshot=null;const restored=await restoreQueryContext(adapter,currentEngine,context,cachedSchemas);if(restored)cachedSchemas=restored.schemas;
    const started=performance.now(),results=[],statementOutputs=[];let changes=0,retained=0,scopeKnown=true;
    const progress=data=>window?.webContents.send('execution:progress',{runId,...data});
    for(let index=0;index<statements.length;index++){
      if (execution.controller.signal.aborted) break;
      const sql=statements[index],time=new Date().toISOString(),tick=performance.now();progress({index,phase:'start',sql,time});
      try{
        const output=visibleResults(await executeTimed(adapter,currentEngine,sql,timeoutMs,{rowLimit:limit,signal:execution.controller.signal,openControl:controlFor(adapter),runId,onCancellationReleased:()=>window?.webContents.send('execution:released',{runId,key})}),limit);const size=Buffer.byteLength(JSON.stringify(output.results));
        if(output.results.length===1)decorateResult(output.results[0],{sql,engine:currentEngine,database:currentDatabase||'main',adapter,scopeKnown});
        if(!/^\s*SELECT\b/i.test(sql))scopeKnown=false;
        if(retained+size>32000000||results.length+output.results.length>200)throw new Error('El script supera 32 MB o 200 resultados. La sentencia ya se envió al servidor; reduce los resultados antes de repetirla.');retained+=size;changes+=output.changes||0;
        if(output.results.length)output.results.forEach((result,i)=>results.push({...result,label:`Respuesta ${results.length+1}`,statementIndex:index,sql,elapsed:output.elapsed}));
        else results.push({columns:[],values:[],label:`Respuesta ${results.length+1}`,statementIndex:index,sql,elapsed:output.elapsed,message:`Sentencia ejecutada. ${output.changes||0} filas modificadas.`});
        const item={index,sql,time,status:'success',duration:output.elapsed,rows:output.results.reduce((sum,item)=>sum+item.values.length,0),changes:output.changes||0,truncated:output.results.some(item=>item.truncated)};statementOutputs.push(item);progress({...item,phase:'finish'});
      }catch(error){const duration=Math.round(performance.now()-tick),item={index,sql,time,status:'error',duration,error:error.message,errorCode:error.code};statementOutputs.push(item);results.push({columns:[],values:[],label:`Respuesta ${results.length+1}`,statementIndex:index,sql,elapsed:duration,error:error.message,errorCode:error.code});progress({...item,phase:'finish'});break;}
    }
    let warning;if(!adapter.pendingExecution&&!statementOutputs.some(item=>['QUERY_TIMEOUT','QUERY_CANCELLED'].includes(item.errorCode)))try{if(adapter.alive===false)throw new Error('Sesión cerrada');if(currentEngine==='sqlite'){cachedObjects=await adapter.schema();cachedSchemas=[{name:'main',objects:cachedObjects}];}else{if(adapter.catalogDirty){const catalog=await adapter.catalog();cachedSchemas=catalog.schemas;}currentDatabase=await adapter.currentDatabase();cachedObjects=cachedSchemas.find(item=>item.name===currentDatabase)?.objects||[];}}catch{warning='No se pudo actualizar el explorador tras la ejecución.';}
    const exportToken=randomUUID();exportSnapshot={token:exportToken,results,session:adapter,source:{connection:currentName,connectionKey:currentProfileId||'local',profileSignature:profileSignature(adapter),engine:currentEngine,database:currentDatabase,databaseName:adapter?.databaseName,rowLimit:limit}};return {results,changes,displayLimit:limit,elapsed:Math.round(performance.now()-started),statementOutputs,requestedStatements:statements.length,cancelled:execution.controller.signal.aborted,...databaseStatus(),warning,exportToken};
    } finally { if (activeExecution === execution) activeExecution = null; }
  }));
  register('database:catalog', () => exclusive(async () => {
    if (!adapter) throw new Error('Conecta con una base de datos primero.');
    const catalog = adapter.catalog ? await adapter.catalog() : { database: 'main', schemas: [{ name: 'main', objects: await adapter.schema() }] };
    cachedSchemas = catalog.schemas; currentDatabase = catalog.database;
    cachedObjects = cachedSchemas.find(schema => schema.name === currentDatabase)?.objects ?? [];
    return { ...databaseStatus(), warning: catalog.warning };
  }));
  register('database:select', name => exclusive(async () => {
    if (!adapter?.selectDatabase) throw new Error('La sesión no permite cambiar de base de datos.');
    if (!cachedSchemas.some(schema => schema.name === name)) throw new Error('La base de datos no está en el catálogo visible. Actualiza el explorador.');
    await adapter.selectDatabase(name);
    currentDatabase = name; cachedObjects = cachedSchemas.find(schema => schema.name === name)?.objects ?? [];
    return databaseStatus();
  }));
  register('database:export', async () => {
    if (!adapter) throw new Error('Abre una base de datos primero.');
    if (currentEngine !== 'sqlite') throw new Error('Guardar copia solo está disponible para SQLite.');
    const result = await dialog.showSaveDialog(window, { title: 'Guardar copia SQLite', defaultPath: 'lqtac-export.sqlite', filters: [{ name: 'SQLite', extensions: ['sqlite'] }] });
    if (result.canceled) return false;
    await fs.writeFile(result.filePath, adapter.export());
    return true;
  });
  register('database:status', databaseStatus);
  function tableSession(schema) {
    if (!adapter || adapter.alive === false || !['mysql', 'mariadb'].includes(currentEngine)) throw new Error('El editor de estructura requiere una conexión MySQL o MariaDB activa.');
    if (!cachedSchemas.some(item => item.name === schema)) throw new Error('La base de datos no está en el catálogo visible.');
  }
  register('table:inspect', (schema, table) => exclusive(async () => {
    tableSession(schema);
    return inspectTable(adapter, schema, table);
  }));
  register('table:preview', request => exclusive(async () => {
    if (!request?.draft) throw new Error('Definición de tabla incompleta.');
    tableSession(request.draft.schema);
    let original = null;
    if (request.table) {
      original = await inspectTable(adapter, request.draft.schema, request.table);
      if (original.version !== request.version) throw new Error('La estructura ha cambiado en el servidor. Recarga la tabla antes de editarla.');
    } else {
      const [settings] = await adapter.connection.promise().query('SELECT @@SESSION.sql_mode AS sql_mode, VERSION() AS version');
      request.draft.sqlMode = settings[0]?.[0] || '';
    }
    const plan = buildTablePlan(original, request.draft);
    const token = randomUUID();
    for (const [id, saved] of tablePlans) if (saved.expires < Date.now()) tablePlans.delete(id);
    if (tablePlans.size >= 20) tablePlans.delete(tablePlans.keys().next().value);
    tablePlans.set(token, { ...plan, kind: 'table', schema: request.draft.schema, table: request.table, version: original?.version, sqlMode: original ? original.sqlMode || '' : request.draft.sqlMode || '', session: adapter, expires: Date.now() + 600000 });
    return { token, sql: plan.sql, warnings: plan.warnings };
  }));
  register('table:apply', token => exclusive(async () => {
    const plan = tablePlans.get(token);
    if (!plan || plan.kind !== 'table' || plan.expires < Date.now() || plan.session !== adapter) throw new Error('La revisión ha caducado o la conexión ha cambiado. Genera una nueva vista previa.');
    tableSession(plan.schema);
    if (plan.table && (await inspectTable(adapter, plan.schema, plan.table)).version !== plan.version) throw new Error('La tabla ha cambiado desde la revisión. Recárgala y vuelve a revisar los cambios.');
    if (!plan.table) {
      const [settings] = await adapter.connection.promise().query('SELECT @@SESSION.sql_mode AS sql_mode');
      if ((settings[0]?.[0] || '') !== plan.sqlMode) throw new Error('El modo SQL de la sesión ha cambiado. Genera una nueva vista previa.');
    }
    tablePlans.delete(token);
    await adapter.execute(plan.sql);
    let table = null;
    let warning;
    try {
      const catalog = await adapter.catalog(); cachedSchemas = catalog.schemas; currentDatabase = catalog.database;
      cachedObjects = cachedSchemas.find(item => item.name === currentDatabase)?.objects ?? [];
      table = await inspectTable(adapter, plan.schema, plan.name);
    } catch { warning = 'El SQL se ha aplicado, pero no se pudo recargar la estructura. Actualiza el explorador y vuelve a abrir la tabla.'; }
    return { applied: true, table, warning, status: databaseStatus() };
  }));
  register('trigger:inspect', (schema, name) => exclusive(async () => { tableSession(schema); return inspectTrigger(adapter, schema, name); }));
  register('trigger:preview', request => exclusive(async () => {
    if (!request?.draft) throw new Error('Falta la definición del trigger.');
    tableSession(request.draft.schema);
    let original = null;
    if (request.originalName) {
      original = await inspectTrigger(adapter, request.draft.schema, request.originalName);
      if (original.version !== request.version) throw new Error('El trigger ha cambiado. Recárgalo antes de editar.');
      if (['name', 'timing', 'event', 'body'].every(key => original[key] === request.draft[key])) throw new Error('No hay cambios en el trigger.');
    }
    const createSQL = createTriggerSQL(request.draft, original);
    const [settings] = await adapter.connection.promise().query('SELECT @@SESSION.sql_mode AS sql_mode, @@SESSION.collation_connection AS collation_connection');
    const token = randomUUID();
    for (const [id, saved] of tablePlans) if (saved.expires < Date.now()) tablePlans.delete(id);
    if (tablePlans.size >= 20) tablePlans.delete(tablePlans.keys().next().value);
    const sql = original ? `DROP TRIGGER ${identifier(original.schema)}.${identifier(original.name)};\n\n${createSQL}` : createSQL;
    tablePlans.set(token, { kind: 'trigger', original, draft: structuredClone(request.draft), schema: request.draft.schema, session: adapter, sqlMode: original?.sqlMode ?? settings[0][0], collation: original?.collation || settings[0][1], expires: Date.now() + 600000 });
    return { token, sql };
  }));
  register('trigger:apply', token => exclusive(async () => {
    const plan = tablePlans.get(token);
    if (!plan || plan.kind !== 'trigger' || plan.expires < Date.now() || plan.session !== adapter) throw new Error('La revisión ha caducado o la conexión ha cambiado.');
    tableSession(plan.schema);
    if (plan.original && (await inspectTrigger(adapter, plan.schema, plan.original.name)).version !== plan.original.version) throw new Error('El trigger ha cambiado desde la revisión. No se ha eliminado ni modificado.');
    const worker = await MySQLAdapter.open({ ...adapter.profile, database: plan.schema }, adapter.connection.config.password, { charset: plan.collation });
    try {
      await worker.execute(`SET SESSION sql_mode = ${literal(plan.sqlMode || '')}`);
      // Renaming must never remove the original if the new name is already taken.
      if (!plan.original || plan.original.name !== plan.draft.name) {
        try { await inspectTrigger(worker, plan.schema, plan.draft.name); throw new Error('Ya existe un trigger con ese nombre.'); }
        catch (error) { if (!['ER_TRG_DOES_NOT_EXIST', 'ER_SP_DOES_NOT_EXIST'].includes(error.code)) throw error; }
      }
      let backupPath;
      if (plan.original) {
        const directory = path.join(app.getPath('userData'), 'trigger-backups');
        await fs.mkdir(directory, { recursive: true });
        backupPath = path.join(directory, `${token}.json`);
        await fs.writeFile(backupPath, JSON.stringify({ ...plan.original, restoreSQL: createTriggerSQL(plan.original, plan.original), savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      }
      tablePlans.delete(token);
      const result = await replaceTrigger(worker, plan.original, plan.draft);
      let table = null;
      if (result.applied || result.restored) {
        try { table = await inspectTable(adapter, plan.schema, plan.draft.table); } catch { /* Report apply result even if metadata cannot be refreshed. */ }
      }
      return { ...result, backupPath, table };
    } finally { worker.close(); }
  }));
  const createWindow = () => {
    window = new BrowserWindow({ width: 1440, height: 940, minWidth: 1000, minHeight: 680, title: 'LQTAC Data Base', icon: path.join(__dirname, '../../assets/branding', process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png'), backgroundColor: '#eef2f7', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.loadFile(entry);
    window.on('closed', () => { window = null; });
  };
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { rememberActive(); for (const saved of sessions.values()) saved.adapter.close(); });
