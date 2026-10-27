import { modules } from './modules.js';
import { createConnectionNavigator } from './connection-navigator.js';
import { attachAutocomplete } from './autocomplete.js';
import { initPanelLayout } from './layout.js';
import { createTableDesigner } from './table-designer.js';
import { attachSQLHighlight } from './sql-highlight.js';
import { initialQuery } from './dialect.js';
import { initOutputs } from './outputs.js';
import { initQueryTools } from './query-tools.js';
import { createObjectEditor } from './object-editor.js';
import {initResultsGrid} from './results-grid.js';
import {initSQLFiles} from './sql-files.js';
import {bindQuery} from './query-binding.js';

const $ = selector => document.querySelector(selector);
const api = window.lqtac;
let connection = null;
let busy = false;
let toastTimer;
let pendingSwitch;
let credentialProfile;
let credentialResumeTab=null;
let databasePicker=null;
let tabNavigation=0,tabNavigationQueue=Promise.resolve();
const designer = createTableDesigner({ api, show, runTask: action => task(action), onStatus: status => updateConnection(status), onQuery: sql => newQuery(sql), notify });
const navigator = createConnectionNavigator({ api, runTask: action => task(action), notify, isBusy: () => busy,
  onConnect: profile => requestRemote(profile), onDisconnect: key => disconnectSaved(key), onActivate: key => activateSaved(key),
  onDelete: ids => removeSaved(ids), onEdit: profile => editProfile(profile),
  onObject: (key, kind, first, second) => openConnectionObject(key, kind, first, second)
});
const autocomplete = attachAutocomplete($('#query'), $('#table-completions'), () => connection,(tables,key)=>api.columns(tables,key));
const sqlHighlight = attachSQLHighlight($('#query'));
const outputs = initOutputs({api,notify});
const resultsGrid=initResultsGrid({api,notify});
const queryTools = initQueryTools({api,getConnection:()=>connection,runSelection:()=>run(true),runTask:action=>task(action),notify,isBusy:()=>busy,getExportRows:()=>resultsGrid.exportRows()});
const objectEditor=createObjectEditor({api,runTask:action=>task(action),getConnection:()=>connection,onChange:async()=>{autocomplete.invalidate();updateConnection(await api.catalog());},notify});
initPanelLayout();
const defaultSql = '-- Tu primera consulta en LQTAC Data Base\nSELECT * FROM proyectos;';
let tabs;
try { tabs = JSON.parse(localStorage.getItem('lqtac.queries')); } catch { /* Start with a fresh draft if local storage is unavailable. */ }
if (!Array.isArray(tabs) || !tabs.every(t => t && typeof t.id === 'string' && typeof t.sql === 'string')) tabs = [{ id: crypto.randomUUID(), sql: defaultSql }];
tabs.forEach((tab, index) => { if (typeof tab.title !== 'string') tab.title = `Consulta ${index + 1}`; });
let nextQueryNumber = Math.max(0, ...tabs.map(tab => Number(tab.title.match(/^Consulta (\d+)$/)?.[1]) || 0)) + 1;
let savedActive;try{savedActive=localStorage.getItem('lqtac.activeQuery');}catch{}
let activeTab = tabs.find(tab=>tab.id===savedActive)?.id??tabs[0]?.id??null;
let closedTabs;
try { closedTabs = JSON.parse(localStorage.getItem('lqtac.closedQueries')); } catch { /* Recoverable drafts are optional. */ }
if (!Array.isArray(closedTabs)) closedTabs = [];
closedTabs = closedTabs.filter(tab => tab && typeof tab.id === 'string' && typeof tab.sql === 'string' && typeof tab.title === 'string').slice(-20);

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function notify(message) {
  $('#toast').textContent = message;
  $('#toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 5000);
}
function persist() {
  try { localStorage.setItem('lqtac.queries', JSON.stringify(tabs));localStorage.setItem('lqtac.activeQuery',activeTab||''); $('#draft-status').textContent = 'Borrador guardado en este equipo'; }
  catch { $('#draft-status').textContent = 'Borrador solo en esta sesión'; }
}
function show(view) {
  autocomplete.close();
  if (view === 'sql' && !tabs.length) { newQuery(); return; }
  for (const section of document.querySelectorAll('.view')) section.classList.toggle('hidden', section.id !== view);
  for (const button of document.querySelectorAll('[data-view]')) button.classList.toggle('active', button.dataset.view === view);
  $('#breadcrumb').textContent = { home: 'Inicio', connections: 'Conexiones', sql: 'Editor SQL', modules: 'Módulos', 'table-designer': 'Estructura de tabla' }[view];
  $('#designer-tab').classList.toggle('active', view === 'table-designer');
  if (view === 'connections') loadProfiles();
  if (view === 'sql') { sqlHighlight.refresh(); $('#query').focus(); }
}
function renderTabs() {
  const root = $('#query-tabs');
  root.replaceChildren();
  root.setAttribute('role', 'tablist');
  tabs.forEach(tab => {
    const wrapper = element('div', undefined, `query-tab${tab.id === activeTab ? ' active' : ''}`);
    wrapper.dataset.id = tab.id;
    const button = element('button', tab.title+(tab.sqlFileDirty?' •':''), 'tab tab-select');
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(tab.id === activeTab));
    button.setAttribute('aria-controls', 'sql');
    button.title = `${tab.title} · ${tab.connectionName || 'Sin conexión asignada'}`;
    button.onclick = () => selectTab(tab.id);
    const close = element('button', '×', 'tab-close');
    close.title = `Cerrar ${tab.title} (Ctrl+W)`;
    close.setAttribute('aria-label', `Cerrar ${tab.title}`);
    close.onclick = () => closeTab(tab.id);
    wrapper.onauxclick = event => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } };
    wrapper.append(button, close); root.append(wrapper);
  });
}
function clearResults() {
  resultsGrid.clear();
  queryTools.clearResults();
  $('#results').replaceChildren(element('div', 'Ejecuta esta consulta para ver sus resultados.', 'result-placeholder'));
  $('#query-info').textContent = 'Listo para ejecutar';
}
async function selectTab(id, force = false) {
  if (busy && !force) return;
  const tab = tabs.find(item => item.id === id);
  if (!tab) return;
  const navigation=++tabNavigation;
  if (activeTab !== id) clearResults();
  activeTab = id; $('#query').value = tab.sql;persist(); renderTabs();show('sql');renderDatabasePicker();
  tabNavigationQueue=tabNavigationQueue.catch(()=>{}).then(async()=>{
    const current=()=>navigation===tabNavigation&&activeTab===id&&tabs.includes(tab);
    if(!current()||!tab.connectionKey)return;
    try{const data=await api.activateConnection(tab.connectionKey);if(!current())return;const context=bindQuery(tab,data);updateConnection(data);
      try{const restored=await api.restoreContext(tab.connectionKey,context);if(current()){updateConnection(restored);persist();}}catch(error){if(current())notify(error.message);}
    }catch(error){if(current()){updateConnection({name:tab.connectionName||'Conexión cerrada',profileId:tab.connectionKey==='local'?null:tab.connectionKey,sessionKey:tab.connectionKey,connected:false,engine:tab.connectionEngine||(tab.connectionKey==='local'?'sqlite':'mysql'),objects:[],schemas:[],database:''});notify(error.message);}}
  });
  await tabNavigationQueue;
}
function persistClosed() {
  try { localStorage.setItem('lqtac.closedQueries', JSON.stringify(closedTabs)); } catch { /* Keep the recovery stack in memory. */ }
}
function closeTab(id) {
  if (busy) return;
  const index = tabs.findIndex(tab => tab.id === id);
  if (index < 0) return;
  const wasActive=activeTab===id;
  if(wasActive)tabNavigation++;
  const [closed] = tabs.splice(index, 1);
  closedTabs.push(closed); closedTabs = closedTabs.slice(-20); persistClosed();
  autocomplete.close();
  if (activeTab === id) {
    activeTab = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
    $('#query').value = tabs.find(tab => tab.id === activeTab)?.sql ?? '';
    sqlHighlight.refresh();
    clearResults();
  }
  persist(); renderTabs();
  if (!tabs.length) show('home');
  else if(wasActive)selectTab(activeTab,true);
  notify(`${closed.title} cerrada. Ctrl+Mayús+T para recuperarla.`);
}
function reopenTab() {
  if (busy) return;
  const tab = closedTabs.pop();
  if (!tab) return notify('No hay consultas cerradas para recuperar.');
  if (tabs.some(item => item.id === tab.id)) tab.id = crypto.randomUUID();
  nextQueryNumber = Math.max(nextQueryNumber, (Number(tab.title.match(/^Consulta (\d+)$/)?.[1]) || 0) + 1);
  tabs.push(tab); persistClosed(); persist(); selectTab(tab.id);
}
function newQuery(sql = connection?.engine === 'mongodb' ? '{"ping":1}' : '-- Nueva consulta\n') {
  tabNavigation++;
  const tab = { id: crypto.randomUUID(), title: `Consulta ${nextQueryNumber++}`, sql, connectionKey: connection?.sessionKey || null, connectionName: connection?.name || '', connectionEngine: connection?.engine || '' };
  if(connection?.connected)bindQuery(tab,connection);
  tabs.push(tab); activeTab = tab.id;
  $('#query').value = sql; clearResults(); persist(); renderTabs(); show('sql');
  renderDatabasePicker();
  return tab;
}
function updateConnection(data) {
  designer.setConnection(data);
  autocomplete.invalidate();
  connection = data.connected === false ? null : data;
  const remote = data.engine && data.engine !== 'sqlite';
  const engine = remote ? engineNames[data.engine] : 'SQLite';
  sqlHighlight.setDialect(data.engine);
  $('#connection-label').textContent = data.name || 'Sin conexión';
  $('#active-database').textContent = data.name ? `${data.scope === 'schema' ? 'Esquema' : 'Base'}: ${data.database || 'sin seleccionar'}${data.databaseName ? ` · Base/servicio: ${data.databaseName}` : ''}` : '';
  $('#status').textContent = data.name ? `${data.name} · ${engine} · ${data.database || 'sin base predeterminada'} · ${data.connected === false ? 'desconectado' : remote ? 'servidor' : 'copia en memoria'}` : 'Sin conexión';
  $('#status-dot').classList.toggle('connected', !!connection);
  $('#sql-dialect').textContent = data.engine === 'mongodb' ? 'JSON / MongoDB' : `SQL / ${engine}`;
  $('#query').setAttribute('aria-label', data.engine === 'mongodb' ? 'Editor de comandos MongoDB JSON' : 'Editor de consultas SQL');
  $('#query').placeholder = data.engine === 'mongodb' ? '{"find":"clientes","filter":{},"limit":100}' : '-- Escribe SQL. Ctrl+Espacio: autocompletar tablas';
  $('#export-db').classList.toggle('hidden', remote);
  $('#disconnect-db').classList.toggle('hidden', !data.name);
  $('#execution-note').textContent = remote
    ? 'Conexión directa al servidor. Los cambios afectan a la base real (autocommit por defecto). Ejecuta una sentencia o selección cada vez. Máximo 1.000 filas visibles; tiempo límite: 30 segundos.'
    : 'Trabajas sobre una copia en memoria. «Guardar copia» exporta el estado actual a un archivo SQLite. Los cambios se pierden al cambiar de base o cerrar la aplicación.';
  if (data.engine === 'mongodb') $('#execution-note').textContent = 'MongoDB: un comando JSON / Extended JSON por ejecución. Ejemplo: {"find":"clientes","filter":{},"limit":100}. Admite $db para elegir la base. No ejecuta JavaScript de mongosh. Los comandos de escritura modifican el servidor. Máximo 1.000 documentos visibles.';
  if (data.engine === 'clickhouse') $('#execution-note').textContent = 'ClickHouse vía HTTP(S): una sentencia por ejecución. Resultados JSONCompact, máximo 1.000 filas visibles. Los cambios se aplican al servidor. Usa la estrella para cambiar de base.';
  if (data.engine === 'postgresql') $('#execution-note').textContent = 'PostgreSQL: esquemas de la base conectada; la estrella configura search_path. Autocommit salvo BEGIN explícito. Máximo 1.000 filas por resultado. Para otra base, crea otro perfil.';
  if (data.engine === 'sqlserver') $('#execution-note').textContent = 'SQL Server: esquemas de la base conectada. Sesión persistente para transacciones y tablas temporales. Consultas con TOP; GO es un separador de cliente y no se envía al servidor. Máximo 1.000 filas por resultado.';
  if (data.engine === 'oracle') $('#execution-note').textContent = 'Oracle Thin: esquemas del servicio conectado. DML requiere COMMIT para guardar o ROLLBACK para descartar; DDL puede confirmar implícitamente. Ejecuta una sentencia o bloque PL/SQL cada vez. Máximo 1.000 filas. La estrella cambia CURRENT_SCHEMA.';
  navigator.refresh();
  renderDatabasePicker();
}
function renderDatabasePicker(){
  if(!databasePicker){databasePicker=document.createElement('select');databasePicker.id='query-database';databasePicker.setAttribute('aria-label','Base o esquema asociado a esta consulta');databasePicker.dataset.hint='Base o esquema de esta consulta · Se conserva al cerrar y se restaura antes de ejecutar';databasePicker.onchange=()=>{if(busy){renderDatabasePicker();return;}if(databasePicker.value)selectDatabase(databasePicker.value);};document.querySelector('.editor-toolbar>label').append(databasePicker);}
  databasePicker.hidden=!connection||['sqlite','sqlserver'].includes(connection.engine);databasePicker.disabled=!connection||busy;
  const tab=tabs.find(item=>item.id===activeTab);const desired=tab?.connectionKey===connection?.sessionKey?tab.connectionDatabase:connection?.database;
  databasePicker.replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent=connection?.scope==='schema'?'Seleccionar esquema…':'Seleccionar base…';databasePicker.append(empty);
  for(const item of connection?.schemas||[]){const option=document.createElement('option');option.value=item.name;option.textContent=item.name;databasePicker.append(option);}databasePicker.value=desired||'';
}
async function task(action) {
  if (busy) return;
  busy = true;
  const buttonStates = new Map([...document.querySelectorAll('button:not([data-local-action])')].map(button => [button, button.disabled]));
  for (const button of buttonStates.keys()) button.disabled = true;
  try { await tabNavigationQueue;return await action(); }
  catch (error) { notify(error.message); }
  finally { busy = false; for (const [button, disabled] of buttonStates) if (button.isConnected) button.disabled = disabled; queryTools.syncButtons();document.dispatchEvent(new Event('lqtac:sync-copy'));renderDatabasePicker(); }
}
async function connect(kind) {
  if (!api) { notify('Abre la aplicación con Electron para acceder a las bases de datos.'); return; }
  const overview = await api.connectionOverview();
  if (overview.sessions.some(state => state.sessionKey === 'local' && state.connected)) {
    pendingSwitch = kind;
    $('#switch-dialog p').textContent = 'Se sustituirá la copia SQLite local abierta. Guarda una copia antes de continuar si quieres conservar sus cambios. Las conexiones a servidor permanecerán abiertas.';
    $('#switch-dialog').showModal();
    return;
  }
  await performConnection(kind);
}
async function performConnection(kind) {
  await task(async () => {
    const data = await api[kind]();
    if (!data) return;
    updateConnection(data);
    $('#results').replaceChildren(element('div', 'Conexión abierta. Ejecuta una consulta para ver sus resultados.', 'result-placeholder'));
    $('#query-info').textContent = 'Listo para ejecutar';
    if (kind === 'demo') newQuery(defaultSql);
    else newQuery('-- Base abierta como copia en memoria\nSELECT name, type FROM sqlite_master ORDER BY name;');
    notify(`${data.name}: lista para trabajar`);
  });
}
async function run(selectionOnly=false,all=false) {
  if(busy)return;
  const tab = tabs.find(item => item.id === activeTab);
  if (!connection && !tab?.connectionKey) { notify('Conecta con un servidor o abre una base SQLite.'); return; }
  const source=$('#query').value,start=$('#query').selectionStart,end=$('#query').selectionEnd;
  const options={mode:all?'all':end>start?'selection':'current',cursor:start,start,end};
  if(selectionOnly && $('#query').selectionStart===$('#query').selectionEnd)return notify('Selecciona la subconsulta que quieres ejecutar.');
  await task(async () => {
  if(tab&&activeTab!==tab.id)return notify('La consulta activa ha cambiado. Pulsa Ejecutar de nuevo.');
  queryTools.clearResults();resultsGrid.clear();$('#results').replaceChildren(element('div','Preparando ejecución…','result-placeholder'));$('#query-info').textContent='Preparando ejecución…';
  try{if(tab?.connectionKey&&tab.connectionKey!=='local'){
    const overview=await api.connectionOverview();
    if(!overview.sessions.some(item=>item.sessionKey===tab.connectionKey&&item.connected)){
      const profile=overview.profiles.find(item=>item.id===tab.connectionKey);if(profile){openCredentials(profile,tab.id);notify('Reconecta el perfil de esta consulta. Después pulsa Ejecutar.');return;}
      return notify('El perfil asociado a esta consulta ya no existe.');
    }
  }}catch(error){notify(error.message);return;}
    const started = performance.now(),runId=crypto.randomUUID(),records=new Map(),finished=new Set();let planned=[],unsubscribe=null;
    function progress(item){if(item.runId&&item.runId!==runId)return;let record=records.get(item.index);if(!record){record=outputs.start({sql:item.sql,connection:tab?.connectionName||connection?.name||'',tab:tab?.title||'',time:item.time});records.set(item.index,record);}if(item.phase==='finish'){finished.add(item.index);outputs.finish(record,{status:item.status,duration:item.duration,message:item.error||`${item.rows||0} filas devueltas · ${item.changes||0} filas modificadas${item.truncated?' · Resultado limitado':''}`});}}
    try {
    if (tab?.connectionKey) await ensureSession(tab.connectionKey);
    if (!connection) throw new Error('Conecta la sesión de esta consulta antes de ejecutar.');
    const context=tab?bindQuery(tab,connection):{database:connection.database||'',databaseName:connection.databaseName||''};persist();renderDatabasePicker();
      const key=tab?.connectionKey||connection.sessionKey;planned=await api.planExecution(source,options,key);
      $('#query-info').textContent = `Ejecutando ${planned.length} sentencia(s)…`;
      unsubscribe=api.onExecutionProgress(progress);
      const output = await api.executeBatch(planned.map(item=>item.sql),key,Number($('#result-limit').value),context,runId);
      queryTools.updateResults(output);
      for(const item of output.statementOutputs)progress({...item,phase:'finish'});
      updateConnection(output);
      if (output.warning) notify(output.warning);
      resultsGrid.setOutput(output);
      const errorIndex=output.results.findIndex(result=>result.error);if(errorIndex>=0){$('#export-result-index').value=String(errorIndex);$('#export-result-index').dispatchEvent(new Event('change'));notify('Ejecución detenida en el primer error. Los cambios anteriores no se deshacen automáticamente.');}else if(all)notify(`${output.statementOutputs.length} sentencias ejecutadas.`);
    } catch (error) {
      if(!records.size)progress({index:0,sql:planned[0]?.sql||source.slice(start,end)||source,phase:'start'});
      for(const [index,record]of records)if(!finished.has(index))outputs.finish(record,{message:error.message,duration:Math.round(performance.now()-started),status:'error'});
      $('#results').replaceChildren(element('div', error.message, 'error'));
      $('#query-info').textContent = 'Error de consulta';
      // Earlier statements in a script may have succeeded before a SQL error.
      updateConnection(await api.status());
    }finally{unsubscribe?.();}
  });
}

for (const module of modules) {
  const card = element('button', undefined, `card${module.action ? ' available' : ''}`);
  card.append(element('span', module.icon, 'card-icon'), element('h3', module.title), element('p', module.description), element('span', module.status, 'pill'));
  card.onclick = () => show(module.action ?? 'modules');
  $('#module-cards').append(card);
  const row = element('article', undefined, 'module-row');
  const copy = element('div'); copy.append(element('h3', module.title), element('p', module.description));
  row.append(element('span', module.icon, 'card-icon'), copy, element('span', module.status, 'pill'));
  $('#module-list').append(row);
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => show(button.dataset.view));
for (const id of ['#open-home', '#open-side']) $(id).onclick = () => connect('open');
for (const id of ['#demo-home', '#demo-lab']) $(id).onclick = () => connect('demo');
$('#cancel-switch').onclick = () => { pendingSwitch = null; $('#switch-dialog').close(); };
$('#confirm-switch').onclick = () => { if (!pendingSwitch) return; const kind = pendingSwitch; pendingSwitch = null; $('#switch-dialog').close(); if (kind?.profile) openCredentials(kind.profile); else performConnection(kind); };
$('#new-query').onclick = () => { if (!busy) newQuery(); };
$('#run-query').onclick = ()=>run();
const runAll=element('button','⚡','mini-tool');runAll.id='run-all';runAll.setAttribute('aria-label','Ejecutar todas las consultas');runAll.dataset.hint='Ejecutar todo · F5 · Lanza el documento en orden y se detiene en el primer error. Las escrituras anteriores no se revierten automáticamente';runAll.onclick=()=>run(false,true);$('#run-selection').after(runAll);
$('#run-query').title='Ejecutar sentencia del cursor o selección · Ctrl+Enter';
$('#export-db').onclick = () => task(async () => {
  if (!connection) return notify('Abre una base de datos primero.');
  if (await api.export()) notify('Copia SQLite guardada.');
});
$('#query').value = tabs.find(tab=>tab.id===activeTab)?.sql ?? '';
sqlHighlight.refresh();
$('#query').addEventListener('input', () => { const tab = tabs.find(t => t.id === activeTab); if (tab) { tab.sql = $('#query').value;if(tab.sqlFileId)tab.sqlFileDirty=true;persist();renderTabs(); } });
initSQLFiles({api,runTask:action=>task(action),getDocument:()=>tabs.find(tab=>tab.id===activeTab),onOpen:file=>{const tab=newQuery(file.sql);tab.title=file.name;tab.sqlFileId=file.id;tab.sqlFileDirty=false;persist();renderTabs();},onSaved:(id,file,sql)=>{const tab=tabs.find(tab=>tab.id===id);if(tab){tab.title=file.name;tab.sqlFileId=file.id;tab.sqlFileDirty=tab.sql!==sql;persist();renderTabs();}},notify,isBusy:()=>busy});
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
  if(event.key==='F5'&&!$('#sql').classList.contains('hidden')){event.preventDefault();run(false,true);return;}
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w' && !$('#sql').classList.contains('hidden')) { event.preventDefault(); closeTab(activeTab); return; }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 't') { event.preventDefault(); reopenTab(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!$('#sql').classList.contains('hidden')) run(event.shiftKey); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); if (!busy) newQuery(); }
});
renderTabs();

const profileForm = $('#connection-form');
const engineNames = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', sqlserver: 'SQL Server', oracle: 'Oracle', clickhouse: 'ClickHouse', mongodb: 'MongoDB' };
const defaultPorts = { postgresql: 5432, mysql: 3306, mariadb: 3306, sqlserver: 1433, oracle: 1521, clickhouse: 8123, mongodb: 27017 };
const supportedEngines = Object.keys(engineNames);
function updateProfileHints() {
  const engine = profileForm.elements.engine.value;
  profileForm.elements.username.required = engine !== 'mongodb';
  profileForm.elements.database.required = engine === 'oracle';
  $('#database-field-label').textContent = engine === 'oracle' ? 'Servicio Oracle (SERVICE_NAME)' : 'Base de datos predeterminada (opcional)';
  profileForm.elements.username.placeholder = engine === 'mongodb' ? 'Vacío para conectar sin autenticación' : engine === 'clickhouse' ? 'default' : 'Usuario del servidor';
  $('#mongo-auth-source').classList.toggle('hidden', engine !== 'mongodb');
  profileForm.elements.database.placeholder = engine === 'mongodb' ? 'test si se deja vacío' : engine === 'clickhouse' ? 'default si se deja vacío' : 'Vacío para explorar todas las bases disponibles';
  $('#engine-hint').textContent = engine === 'clickhouse' ? 'Conexión HTTP: puerto 8123; HTTPS/TLS: normalmente 8443. No utiliza el puerto nativo 9000. La contraseña no se guarda.' : engine === 'mongodb' ? 'Conexión TCP con usuario y contraseña. authSource: admin por defecto. Introduce el host, sin mongodb://. SRV/Atlas y réplicas mediante URI quedan pendientes. La contraseña no se guarda.' : 'La contraseña se solicita al conectar y no se guarda en el perfil.';
  if (engine === 'postgresql') { profileForm.elements.database.placeholder = 'postgres si se deja vacío'; $('#engine-hint').textContent = 'PostgreSQL con usuario/contraseña y TLS opcional. El explorador muestra los esquemas de la base conectada. La contraseña no se guarda.'; }
  if (engine === 'sqlserver') $('#engine-hint').textContent = 'SQL Server por TCP y autenticación SQL (usuario/contraseña). Usa el puerto TCP de la instancia. TLS verifica el certificado. Sin base, se utiliza la predeterminada del usuario. Autenticación Windows integrada no incluida.';
  if (engine === 'oracle') { profileForm.elements.database.placeholder = 'FREEPDB1, XEPDB1 o servicio configurado'; $('#engine-hint').textContent = 'Oracle 12.1 o superior en modo Thin, sin Oracle Client. Indica SERVICE_NAME, usuario y contraseña; TLS usa TCPS. La base del perfil es el servicio, no el esquema.'; }
}
function editProfile(profile) {
  profileForm.reset();
  profileForm.elements.id.value = '';
  if (profile) for (const [key, value] of Object.entries(profile)) {
    const field = profileForm.elements.namedItem(key);
    if (field) { if (field.type === 'checkbox') field.checked = value === true; else field.value = value; }
  }
  $('#profile-heading').textContent = profile ? 'Editar conexión' : 'Nueva conexión';
  $('#profile-error').textContent = '';
  updateProfileHints();
  $('#connection-dialog').showModal();
  profileForm.elements.namedItem('name').focus();
}
async function loadProfiles() {
  const root = $('#connection-profiles');
  if (!api) { root.replaceChildren(element('p', 'Abre la aplicación de escritorio para gestionar los perfiles.', 'intro')); return; }
  try {
    const profiles = await api.listConnections();
    const overview = await api.connectionOverview();
    root.replaceChildren();
    if (!profiles.length) root.append(element('div', 'Todavía no hay conexiones guardadas. Crea tu primer perfil de servidor.', 'profiles-empty'));
    for (const profile of profiles) {
      const row = element('article', undefined, 'module-row profile-row');
      const copy = element('div', undefined, 'profile-copy');
      copy.append(element('h3', profile.name), element('p', `${engineNames[profile.engine]} · ${profile.host}:${profile.port} · ${profile.database || 'Sin base predeterminada'}`), element('p', `Usuario: ${profile.username}`));
      const edit = element('button', 'Editar', 'secondary');
      edit.onclick = () => editProfile(profile);
      const supported = supportedEngines.includes(profile.engine);
      const connected = overview.sessions.some(state => state.profileId === profile.id && state.connected);
      row.append(element('span', '⇄', 'card-icon'), copy, element('span', connected ? 'Conectado' : supported ? 'Sin conectar' : 'Driver pendiente', 'pill'), edit);
      if (supported) {
        const button = element('button', connected ? 'Abrir editor' : 'Conectar', 'primary');
        button.onclick = () => connected ? activateSaved(profile.id) : requestRemote(profile);
        row.append(button);
      }
      root.append(row);
    }
    navigator.refresh();
  } catch (error) { root.replaceChildren(element('p', `No se pudieron cargar las conexiones: ${error.message}`, 'error')); }
}
for (const id of ['#new-connection', '#new-connection-home']) $(id).onclick = () => { show('connections'); editProfile(); };
$('#new-profile-side').onclick = () => editProfile();
$('#cancel-profile').onclick = () => $('#connection-dialog').close();
profileForm.elements.engine.onchange = () => { profileForm.elements.port.value = defaultPorts[profileForm.elements.engine.value]; updateProfileHints(); };
profileForm.elements.tls.onchange = () => { if (profileForm.elements.engine.value === 'clickhouse' && [8123, 8443].includes(Number(profileForm.elements.port.value))) profileForm.elements.port.value = profileForm.elements.tls.checked ? 8443 : 8123; };
profileForm.onsubmit = async event => {
  event.preventDefault();
  if (busy || !api || !profileForm.reportValidity()) return;
  const profile = Object.fromEntries(new FormData(profileForm));
  profile.tls = profileForm.elements.tls.checked;
  busy = true;
  const submit = profileForm.querySelector('[type="submit"]'); submit.disabled = true;
  $('#profile-error').textContent = '';
  try {
    await api.saveConnection(profile);
    $('#connection-dialog').close();
    await loadProfiles();
    notify('Perfil guardado en este equipo.');
  } catch (error) { $('#profile-error').textContent = error.message; }
  finally { busy = false; submit.disabled = false; }
};

async function requestRemote(profile) {
  if (busy || !profile || $('#credentials-dialog').open) return;
  if (!supportedEngines.includes(profile.engine)) return notify('Este motor todavía no tiene driver integrado.');
  try {
    const overview = await api.connectionOverview();
    if (overview.sessions.some(state => state.profileId === profile.id && state.connected)) return activateSaved(profile.id);
    openCredentials(profile);
  } catch (error) { notify(error.message); }
}
function openCredentials(profile,resumeTab=null) {
  credentialProfile = profile;
  credentialResumeTab=resumeTab;
  $('#connection-password').value = '';
  $('#credentials-message').textContent = '';
  $('#credentials-heading').textContent = `Conectar a ${profile.name}`;
  $('#credentials-target').textContent = `${engineNames[profile.engine]} · ${profile.host}:${profile.port} · ${profile.database || 'Sin base predeterminada'} · ${profile.username}`;
  $('#credentials-dialog').showModal();
  $('#connection-password').focus();
}
async function authenticate(testOnly) {
  if (busy || !credentialProfile) return;
  busy = true;
  const dialog = $('#credentials-dialog');
  for (const button of dialog.querySelectorAll('button')) button.disabled = true;
  $('#credentials-message').textContent = testOnly ? 'Probando conexión…' : 'Conectando…';
  try {
    const id = credentialProfile.id;
    if (testOnly) {
      await api.testProfile(id, $('#connection-password').value);
      $('#credentials-message').textContent = 'Conexión correcta. Puedes conectar con esta configuración.';
    } else {
      const resume=tabs.find(tab=>tab.id===(credentialResumeTab||activeTab)&&tab.connectionKey===id);
      const data = await api.connectProfile(id, $('#connection-password').value);
      updateConnection(data);
      $('#results').replaceChildren(element('div', 'Sesión abierta. Ejecuta una consulta para ver sus resultados.', 'result-placeholder'));
      $('#query-info').textContent = 'Listo para ejecutar';
      $('#connection-password').value = '';
      dialog.close(); credentialProfile = null;
      if(resume){bindQuery(resume,data);await selectTab(resume.id,true);}else newQuery(initialQuery(data.engine));
      notify(`Conectado a ${data.name}${data.warning ? '. ' + data.warning : ''}`);
    }
  } catch (error) { $('#credentials-message').textContent = error.message; }
  finally { busy = false; for (const button of dialog.querySelectorAll('button')) button.disabled = false;renderDatabasePicker(); }
}
$('#credentials-form').onsubmit = event => { event.preventDefault(); authenticate(false); };
$('#test-connection').onclick = () => authenticate(true);
$('#cancel-credentials').onclick = () => $('#credentials-dialog').close();
$('#credentials-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('#credentials-dialog').addEventListener('close', () => { $('#connection-password').value = ''; credentialProfile = null;credentialResumeTab=null; });
$('#disconnect-db').onclick = () => task(async () => {
  if (connection?.engine === 'sqlite' && !confirm('Los cambios de SQLite sin exportar se perderán. ¿Desconectar?')) return;
  if (connection?.engine !== 'sqlite' && !confirm('Se cerrará la sesión y se descartarán transacciones no confirmadas. ¿Desconectar?')) return;
  updateConnection(await api.disconnect());
  $('#results').replaceChildren(element('div', 'Sesión cerrada.', 'result-placeholder'));
});
setInterval(async () => {
  if (busy) return;
  try {
    const status = await api.status();
    if (connection && !status.connected) { updateConnection(status); notify('Se ha perdido la conexión. Vuelve a conectar desde Conexiones.'); }
    navigator.refresh();
  } catch { /* The next operation will report an IPC or session error. */ }
}, 5000);

async function selectDatabase(name) {
  await task(async () => {
    updateConnection(await api.selectDatabase(name));
    const tab=tabs.find(tab=>tab.id===activeTab);if(tab&&tab.connectionKey===connection.sessionKey){tab.connectionDatabase=connection.database;tab.connectionDatabaseName=connection.databaseName||'';bindQuery(tab,connection);persist();}renderDatabasePicker();
    notify(`Base predeterminada: ${name}`);
  });
}
$('#refresh-explorer').onclick = () => task(async () => {
  if (connection?.connected) { const data = await api.catalog(); updateConnection(data); notify(data.warning || 'Bases de datos y objetos actualizados.'); }
  await navigator.refresh();
});
$('#explorer-filter').oninput = () => navigator.setFilter($('#explorer-filter').value);
$('#wrap-results').onchange = () => $('#results').classList.toggle('wrap-values', $('#wrap-results').checked);

async function ensureSession(key) {
  updateConnection(await api.activateConnection(key));
}
async function activateSaved(key) {
  await task(async () => {
    await ensureSession(key);
    const tab = [...tabs].reverse().find(item => item.connectionKey === key);
    if (tab) await selectTab(tab.id, true); else newQuery();
  });
}
async function openConnectionObject(key, kind, first, second) {
  if (busy) return;
  try {
    await ensureSession(key);
    if (kind === 'query') newQuery(first);
    else if (kind === 'select') {if(tabs.find(tab=>tab.id===activeTab)?.connectionKey!==key){const tab=[...tabs].reverse().find(tab=>tab.connectionKey===key);if(tab)await selectTab(tab.id);else newQuery();}await selectDatabase(first);}
    else if (kind === 'edit') designer.open(first, second);
    else if (kind === 'create') designer.open(first);
    else if (kind === 'definition') await objectEditor.open(first,second);
  } catch (error) { notify(error.message); }
}
async function disconnectSaved(key) {
  if (busy) return;
  if (!confirm(key === 'local' ? '¿Cerrar la copia SQLite? Los cambios sin exportar se perderán.' : '¿Desconectar esta sesión? Las transacciones no confirmadas se descartarán.')) return;
  await task(async () => { updateConnection(await api.disconnectConnection(key)); await navigator.refresh(); });
}
async function removeSaved(ids) {
  if (busy || !ids.length || !confirm(`¿Borrar ${ids.length} perfil(es) de conexión? Se cerrarán sus sesiones y se descartarán transacciones no confirmadas. Las bases de datos no se borran; se conserva una copia local del perfil.`)) return;
  await task(async () => { updateConnection(await api.removeConnections(ids)); await navigator.refresh(); if (!$('#connections').classList.contains('hidden')) await loadProfiles(); });
}
navigator.refresh();
