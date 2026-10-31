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
import {initEditorIndent} from './editor-indent.js';
import {initSettings} from './settings.js';
import {initSQLToolbar} from './sql-toolbar.js';
import {initDashboard} from './dashboard.js';

const $ = selector => document.querySelector(selector);
const api = window.lqtac;
const openManual = async () => { try { if(!api) throw Error('Abre la aplicación de escritorio para consultar el manual.'); await api.openManual(); } catch(error) { notify(error.message); } };
$('#open-help').onclick = openManual;
$('#about-manual').onclick = openManual;
$('#open-about').onclick = async () => { const dialog=$('#about-dialog'); if(dialog.open)return; $('#about-version').textContent='—'; dialog.showModal(); try { if(api) $('#about-version').textContent=(await api.appInfo()).version; } catch(error) { notify(error.message); } };
$('#close-about').onclick = () => $('#about-dialog').close();
initEditorIndent();
initSettings({api,notify});
let connection = null;
let busy = false;
let sqlExecutionControls = null;
let toastTimer;
let pendingSwitch;
let credentialProfile;
let credentialResumeTab=null;
let databasePicker=null;
let tabNavigation=0,tabNavigationQueue=Promise.resolve();
const designer = createTableDesigner({ api, show, runTask: action => task(action), onStatus: status => updateConnection(status), onQuery: sql => newQuery(sql), notify });
const navigator = createConnectionNavigator({ api, runTask: action => task(action), notify, isBusy: () => busy,
  onConnect: profile => requestRemote(profile), onDisconnect: key => disconnectSaved(key), onActivate: key => activateSaved(key),
  onDashboard: scope => dashboard.open(scope).catch(error=>notify(error.message)),
  onDelete: ids => removeSaved(ids), onEdit: profile => editProfile(profile), onCredentials: profile => openCredentials(profile).catch(error => notify(error.message)),
  onObject: (key, kind, first, second) => openConnectionObject(key, kind, first, second)
});
const autocomplete = attachAutocomplete($('#query'), $('#table-completions'), () => connection,(tables,key)=>api.columns(tables,key));
const sqlHighlight = attachSQLHighlight($('#query'));
const outputs = initOutputs({api,notify});
const resultsGrid=initResultsGrid({api,notify,runTask:action=>task(action),onStatus:status=>updateConnection(status)});
const queryTools = initQueryTools({api,getConnection:()=>connection,runSelection:()=>run(true),runTask:action=>task(action),notify,isBusy:()=>busy,getExportRows:()=>resultsGrid.exportRows(),hasPendingEdits:()=>resultsGrid.hasChanges()});
const dashboard=initDashboard({api,notify,show,getOpenQueries:async()=>{const snapshots=await api.dashboardQueries(tabs.map(t=>t.id));return tabs.map(t=>({...t,snapshot:snapshots.find(s=>s.id===t.id)}));},getConnection:()=>connection,getResults:()=>{const result=resultsGrid.dashboardResults(),tab=tabs.find(t=>t.id===activeTab);if(result&&tab)result.results.forEach((r,i)=>r.label=tab.title+(r.customLabel?' · '+r.label:result.results.length>1?' · Respuesta '+(i+1):''));return result;}});
const objectEditor=createObjectEditor({api,runTask:action=>task(action),getConnection:()=>connection,onChange:async()=>{autocomplete.invalidate();updateConnection(await api.catalog());},notify});
initPanelLayout();
const defaultSql = '-- Tu primera consulta en LQTAC dbFox\nSELECT * FROM proyectos;';
let tabs;
try { tabs = JSON.parse(localStorage.getItem('lqtac.queries')); } catch { /* Start with a fresh draft if local storage is unavailable. */ }
if (!Array.isArray(tabs) || !tabs.every(t => t && typeof t.id === 'string' && typeof t.sql === 'string')) tabs = [{ id: crypto.randomUUID(), sql: defaultSql }];
tabs.forEach((tab, index) => { if (typeof tab.title !== 'string') tab.title = `Consulta ${index + 1}`; });
let nextQueryNumber = Math.max(0, ...tabs.map(tab => Number(tab.title.match(/^Consulta (\d+)$/)?.[1]) || 0)) + 1;
let savedActive;try{savedActive=localStorage.getItem('lqtac.activeQuery');}catch{}
let activeTab = tabs.find(tab=>tab.id===savedActive)?.id??tabs[0]?.id??null;
const responseViews=new Map();
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
  for (const button of document.querySelectorAll('[data-view]')) button.classList.toggle('active', button.dataset.view === (view==='dashboard-library'?'dashboard':view));
  $('#breadcrumb').textContent = { home: 'Inicio', connections: 'Conexiones', sql: 'Editor SQL', modules: 'Módulos', dashboard:'Dashboards', 'dashboard-library':'Biblioteca de dashboards', 'table-designer': 'Estructura de tabla' }[view];
  $('#designer-tab').classList.toggle('active', view === 'table-designer');
  if(view==='dashboard')dashboard.activateEditor();if(view==='dashboard-library')dashboard.deactivateEditor();
  if (view === 'connections') loadProfiles();
  if (view === 'sql') { sqlHighlight.refresh(); $('#query').focus(); }
}
const queryFinder=element('input');queryFinder.id='query-search';queryFinder.type='search';queryFinder.placeholder='Buscar consulta…';queryFinder.setAttribute('aria-label','Buscar consultas por nombre');queryFinder.style.cssText='width:150px;min-width:100px;margin:4px;';$('#query-tabs').before(queryFinder);queryFinder.oninput=()=>renderTabs();
function renderTabs() {
  const root = $('#query-tabs');
  root.replaceChildren();
  root.setAttribute('role', 'tablist');
  tabs.filter(tab=>!queryFinder.value||tab.title.toLocaleLowerCase().includes(queryFinder.value.toLocaleLowerCase())).forEach(tab => {
    const wrapper = element('div', undefined, `query-tab${tab.id === activeTab ? ' active' : ''}`);
    wrapper.dataset.id = tab.id;
    const button = element('button', tab.title+(tab.sqlFileDirty?' •':''), 'tab tab-select');
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(tab.id === activeTab));
    button.setAttribute('aria-controls', 'sql');
    button.title = `${tab.title} · ${tab.connectionName || 'Sin conexión asignada'}`;
    button.onclick = () => selectTab(tab.id);
    button.ondblclick = () => renameQuery(tab);
    button.oncontextmenu = event => {event.preventDefault();renameQuery(tab);};
    button.title += ' · Doble clic o botón derecho para cambiar nombre';
    const close = element('button', '×', 'tab-close');
    close.title = `Cerrar ${tab.title} (Ctrl+W)`;
    close.setAttribute('aria-label', `Cerrar ${tab.title}`);
    close.onclick = () => closeTab(tab.id);
    wrapper.onauxclick = event => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } };
    wrapper.append(button, close); root.append(wrapper);
  });
}
function renameQuery(tab){
  if(busy)return;const dialog=element('dialog',undefined,'db-dialog'),form=element('form'),label=element('label','Nombre de la consulta'),input=element('input');input.id='query-name';input.value=tab.title;input.maxLength=160;input.required=true;label.append(input);const save=element('button','Guardar nombre','primary');save.type='submit';const cancel=element('button','Cancelar','secondary');cancel.type='button';cancel.onclick=()=>dialog.close();form.append(label,cancel,save);form.onsubmit=e=>{e.preventDefault();if(!input.value.trim())return;tab.title=input.value.trim();persist();renderTabs();dialog.close();};dialog.append(form);document.body.append(dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();input.focus();input.select();
}
function rememberResults(){const saved=resultsGrid.snapshot();if(activeTab&&saved)responseViews.set(activeTab,saved);}
function restoreResults(id){const saved=responseViews.get(id);if(!saved){clearResults();return;}queryTools.updateResults(saved.output);resultsGrid.setOutput(saved.output,saved);}
function clearResults() {
  resultsGrid.clear();
  queryTools.clearResults();
  $('#results').replaceChildren(element('div', 'Ejecuta esta consulta para ver sus resultados.', 'result-placeholder'));
  $('#query-info').textContent = 'Listo para ejecutar';
}
async function selectTab(id, force = false) {
  if (busy && !force) return;
  if(id!==activeTab&&!resultsGrid.confirmDiscard())return;
  const tab = tabs.find(item => item.id === id);
  if (!tab) return;
  const navigation=++tabNavigation;
  const switching=activeTab!==id;if(switching)rememberResults();
  activeTab = id; $('#query').value = tab.sql;if(switching||!resultsGrid.snapshot())restoreResults(id);persist(); renderTabs();show('sql');renderDatabasePicker();
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
  if(id===activeTab&&!resultsGrid.confirmDiscard())return;
  const index = tabs.findIndex(tab => tab.id === id);
  if (index < 0) return;
  const wasActive=activeTab===id;
  if(wasActive)tabNavigation++;
  const [closed] = tabs.splice(index, 1);responseViews.delete(closed.id);api.forgetDashboardQuery(closed.id).catch(error=>notify(error.message));
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
  if(!resultsGrid.confirmDiscard())return null;
  rememberResults();tabNavigation++;
  const tab = { id: crypto.randomUUID(), title: `Consulta ${nextQueryNumber++}`, sql, connectionKey: connection?.sessionKey || null, connectionName: connection?.name || '', connectionEngine: connection?.engine || '' };
  if(connection?.connected)bindQuery(tab,connection);
  tabs.push(tab); activeTab = tab.id;
  $('#query').value = sql; clearResults(); persist(); renderTabs(); show('sql');
  renderDatabasePicker();
  return tab;
}
function updateConnection(data) {
  sqlExecutionControls?.observe(data);
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
    ? 'Conexión directa al servidor. Los cambios afectan a la base real (autocommit por defecto). Filas según el selector de resultados. El tiempo máximo por sentencia se configura en ⚙ Configuración.'
    : 'Trabajas sobre una copia en memoria. «Guardar copia» exporta el estado actual a un archivo SQLite. Los cambios se pierden al cambiar de base o cerrar la aplicación.';
  if (data.engine === 'mongodb') $('#execution-note').textContent = 'MongoDB: un comando JSON / Extended JSON por ejecución. Ejemplo: {"find":"clientes","filter":{},"limit":100}. Admite $db para elegir la base. No ejecuta JavaScript de mongosh. Los comandos de escritura modifican el servidor. Filas según el selector de resultados.';
  if (data.engine === 'clickhouse') $('#execution-note').textContent = 'ClickHouse vía HTTP(S): una sentencia por ejecución. Resultados JSONCompact; filas según el selector de resultados. Los cambios se aplican al servidor. Usa la estrella para cambiar de base.';
  if (data.engine === 'postgresql') $('#execution-note').textContent = 'PostgreSQL: esquemas de la base conectada; la estrella configura search_path. Autocommit salvo BEGIN explícito. Filas según el selector de resultados. Para otra base, crea otro perfil.';
  if (data.engine === 'sqlserver') $('#execution-note').textContent = 'SQL Server: esquemas de la base conectada. Sesión persistente para transacciones y tablas temporales. Consultas con TOP; GO es un separador de cliente y no se envía al servidor. Filas según el selector de resultados.';
  if (data.engine === 'oracle') $('#execution-note').textContent = 'Oracle Thin: esquemas del servicio conectado. DML requiere COMMIT para guardar o ROLLBACK para descartar; DDL puede confirmar implícitamente. Ejecuta una sentencia o bloque PL/SQL cada vez. Filas según el selector de resultados. La estrella cambia CURRENT_SCHEMA.';
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
  if(!resultsGrid.confirmDiscard())return;
  await task(async () => {
    const data = await api[kind]();
    if (!data) return;
    updateConnection(data);
    $('#results').replaceChildren(element('div', 'Conexión abierta. Ejecuta una consulta para ver sus resultados.', 'result-placeholder'));
    $('#query-info').textContent = 'Listo para ejecutar';
    if (kind === 'demo') newQuery(defaultSql);
    else if (kind === 'create') newQuery('-- Base SQLite nueva. Usa Guardar copia para conservar los cambios.\n');
    else newQuery('-- Base abierta como copia en memoria\nSELECT name, type FROM sqlite_master ORDER BY name;');
    notify(kind === 'create' ? `${data.name}: creada. Usa Guardar copia para conservar los cambios posteriores.` : `${data.name}: lista para trabajar`);
  });
}
async function run(selectionOnly=false,all=false) {
  if(busy)return;
  if(!resultsGrid.confirmDiscard())return;
  const tab = tabs.find(item => item.id === activeTab);
  if (!connection && !tab?.connectionKey) { notify('Conecta con un servidor o abre una base SQLite.'); return; }
  const source=$('#query').value,start=$('#query').selectionStart,end=$('#query').selectionEnd;
  const options={mode:all?'all':end>start?'selection':'current',cursor:start,start,end};
  if(selectionOnly && $('#query').selectionStart===$('#query').selectionEnd)return notify('Selecciona la subconsulta que quieres ejecutar.');
  await task(async () => {
  if(tab&&activeTab!==tab.id)return notify('La consulta activa ha cambiado. Pulsa Ejecutar de nuevo.');
  if(tab)responseViews.delete(tab.id);queryTools.clearResults();resultsGrid.clear();$('#results').replaceChildren(element('div','Preparando ejecución…','result-placeholder'));$('#query-info').textContent='Preparando ejecución…';
  try{if(tab?.connectionKey&&tab.connectionKey!=='local'){
    const overview=await api.connectionOverview();
    if(!overview.sessions.some(item=>item.sessionKey===tab.connectionKey&&item.connected)){
      const profile=overview.profiles.find(item=>item.id===tab.connectionKey);if(profile){if(!await connectSavedOrPrompt(profile,tab.id))return;} else
      return notify('El perfil asociado a esta consulta ya no existe.');
    }
  }}catch(error){notify(error.message);return;}
    const started = performance.now(),runId=crypto.randomUUID(),records=new Map(),finished=new Set();let planned=[],unsubscribe=null,queryPending=false;
    function progress(item){if(item.runId&&item.runId!==runId)return;if(item.phase==='cancelling'){sqlExecutionControls.cancelling(runId,item.canRetry);$('#query-info').textContent=item.message;return;}if(item.phase==='start')sqlExecutionControls.running(runId);let record=records.get(item.index);if(!record){record=outputs.start({sql:item.sql,connection:tab?.connectionName||connection?.name||'',tab:tab?.title||'',time:item.time});records.set(item.index,record);}if(item.phase==='finish'){finished.add(item.index);outputs.finish(record,{status:item.status,duration:item.duration,message:item.error||`${item.rows||0} filas devueltas · ${item.changes||0} filas modificadas${item.truncated?' · Resultado limitado':''}`});}}
    try {
    if (tab?.connectionKey) await ensureSession(tab.connectionKey);
    if (!connection) throw new Error('Conecta la sesión de esta consulta antes de ejecutar.');
    const context=tab?bindQuery(tab,connection):{database:connection.database||'',databaseName:connection.databaseName||''};persist();renderDatabasePicker();
      const key=tab?.connectionKey||connection.sessionKey;planned=await api.planExecution(source,options,key);
      $('#query-info').textContent = `Ejecutando ${planned.length} sentencia(s)…`;
      unsubscribe=api.onExecutionProgress(progress);
      sqlExecutionControls.prepare({runId,key,engine:connection.engine});
      const output = await api.executeBatch(planned.map(item=>item.sql),key,Number($('#result-limit').value),context,runId);
      if(tab)try{await api.rememberDashboardQuery(tab.id,output.exportToken);}catch(error){notify(error.message);}
      queryPending=output.queryPending;
      queryTools.updateResults(output);
      for(const item of output.statementOutputs)progress({...item,phase:'finish'});
      updateConnection(output);
      if (output.warning) notify(output.warning);
      resultsGrid.setOutput(output);
      const errorIndex=output.results.findIndex(result=>result.error);if(errorIndex>=0){$('#export-result-index').value=String(errorIndex);$('#export-result-index').dispatchEvent(new Event('change'));const failure=output.results[errorIndex];if(failure.errorCode==='QUERY_TIMEOUT'){$('#query-info').textContent='Agotado tiempo máximo de consulta';notify('Agotado tiempo máximo de consulta');}else notify(failure.errorCode==='QUERY_CANCELLED'?failure.error:'Ejecución detenida en el primer error. Los cambios anteriores no se deshacen automáticamente.');}else if(all)notify(`${output.statementOutputs.length} sentencias ejecutadas.`);
    } catch (error) {
      if(!records.size)progress({index:0,sql:planned[0]?.sql||source.slice(start,end)||source,phase:'start'});
      for(const [index,record]of records)if(!finished.has(index))outputs.finish(record,{message:error.message,duration:Math.round(performance.now()-started),status:'error'});
      $('#results').replaceChildren(element('div', error.message, 'error'));
      $('#query-info').textContent = 'Error de consulta';
      // Earlier statements in a script may have succeeded before a SQL error.
      updateConnection(await api.status());
    }finally{unsubscribe?.();sqlExecutionControls.finish(runId,queryPending);}
  });
}

for (const module of modules) {
  const card = element('button', undefined, `card${module.action ? ' available' : ''}`);
  card.append(element('span', module.icon, 'card-icon'), element('h3', module.title), element('p', module.description), element('span', module.status, 'pill'));
  card.onclick = () => module.action==='dashboard'?dashboard.open():show(module.action ?? 'modules');
  $('#module-cards').append(card);
  const row = element('article', undefined, 'module-row');
  const copy = element('div'); copy.append(element('h3', module.title), element('p', module.description));
  row.append(element('span', module.icon, 'card-icon'), copy, element('span', module.status, 'pill'));
  $('#module-list').append(row);
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {if(button.dataset.view!=='dashboard')show(button.dataset.view);});
for (const id of ['#open-home', '#open-side']) $(id).onclick = () => connect('open');
for (const id of ['#create-sqlite-home', '#create-sqlite-connections']) $(id).onclick = () => connect('create');
for (const id of ['#demo-home', '#demo-lab']) $(id).onclick = () => connect('demo');
$('#cancel-switch').onclick = () => { pendingSwitch = null; $('#switch-dialog').close(); };
$('#confirm-switch').onclick = () => { if (!pendingSwitch) return; const kind = pendingSwitch; pendingSwitch = null; $('#switch-dialog').close(); if (kind?.profile) requestRemote(kind.profile); else performConnection(kind); };
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
initSQLFiles({api,runTask:action=>task(action),getDocument:()=>tabs.find(tab=>tab.id===activeTab),onOpen:file=>{const tab=newQuery(file.sql);if(!tab)return;tab.title=file.name;tab.sqlFileId=file.id;tab.sqlFileDirty=false;persist();renderTabs();},onSaved:(id,file,sql)=>{const tab=tabs.find(tab=>tab.id===id);if(tab){tab.title=file.name;tab.sqlFileId=file.id;tab.sqlFileDirty=tab.sql!==sql;persist();renderTabs();}},notify,isBusy:()=>busy});
sqlExecutionControls = initSQLToolbar({api,notify});
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
  $('#engine-hint').textContent = engine === 'clickhouse' ? 'Conexión HTTP: puerto 8123; HTTPS/TLS: normalmente 8443. No utiliza el puerto nativo 9000. Puedes guardar la contraseña cifrada al conectar.' : engine === 'mongodb' ? 'Conexión TCP con usuario y contraseña. authSource: admin por defecto. Introduce el host, sin mongodb://. SRV/Atlas y réplicas mediante URI quedan pendientes. Puedes guardar la contraseña cifrada al conectar.' : 'La contraseña se solicita al conectar y puede guardarse de forma opcional.';
  if (engine === 'postgresql') { profileForm.elements.database.placeholder = 'postgres si se deja vacío'; $('#engine-hint').textContent = 'PostgreSQL con usuario/contraseña y TLS opcional. El explorador muestra los esquemas de la base conectada. Puedes guardar la contraseña cifrada al conectar.'; }
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
$('#connection-backup-side').onclick = () => { show('connections'); loadProfiles(); };
let connectionBackupMode = null;
function openConnectionBackup(mode) {
  if (busy || !api) return;
  connectionBackupMode=mode;
  const exporting=mode==='export';
  $('#connection-backup-title').textContent=exporting?'Exportar conexiones':'Importar conexiones';
  $('#connection-backup-description').textContent=exporting?'La copia incluirá conexiones, grupos y contraseñas guardadas. Elige una contraseña para cifrar el archivo .foxdb. Guárdala: la necesitarás para restaurarlo.':'Introduce la contraseña de la copia y selecciona el archivo .foxdb o .lqtdb. Después podrás revisar el resumen antes de restaurar.';
  $('#connection-backup-password').value=''; $('#connection-backup-confirm').value='';
  $('#connection-backup-confirm-label').hidden=!exporting;
  $('#connection-backup-confirm').required=exporting;
  $('#connection-backup-error').textContent='';
  $('#connection-backup-dialog').showModal(); $('#connection-backup-password').focus();
}
$('#export-connections').onclick=()=>openConnectionBackup('export');
$('#import-connections').onclick=()=>openConnectionBackup('import');
$('#connection-backup-cancel').onclick=()=>$('#connection-backup-dialog').close();
$('#connection-backup-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
$('#connection-backup-dialog').addEventListener('close',()=>{ $('#connection-backup-password').value=''; $('#connection-backup-confirm').value=''; connectionBackupMode=null; });
$('#connection-backup-form').onsubmit=async event=>{
  event.preventDefault(); if(busy || !event.target.reportValidity())return;
  const mode=connectionBackupMode, password=$('#connection-backup-password').value;
  if(mode==='export' && password!==$('#connection-backup-confirm').value){$('#connection-backup-error').textContent='Las contraseñas no coinciden.';return;}
  const buttons=[...event.target.querySelectorAll('button')]; buttons.forEach(button=>button.disabled=true); busy=true;
  $('#connection-backup-error').textContent='';
  try {
    if(mode==='export') {
      const result=await api.exportConnections(password);
      if(result){$('#connection-backup-dialog').close();notify(`Copia exportada: ${result.profiles} conexiones y ${result.groups} grupos.`);}
    } else {
      const result=await api.prepareConnectionImport(password);
      if(!result)return;
      if(!confirm(`La copia contiene ${result.profiles} conexiones, ${result.groups} grupos y ${result.passwords} contraseñas guardadas.\n\nSe sustituirá toda la configuración actual de conexiones y grupos. Desconecta primero los servidores. Se conservará una copia local de la configuración anterior.\n\n¿Restaurar esta copia?`)){await api.cancelConnectionImport(result.token);return;}
      await api.finishConnectionImport(result.token);
      $('#connection-backup-dialog').close(); await loadProfiles();
      notify(`Copia restaurada: ${result.profiles} conexiones y ${result.groups} grupos.`);
    }
  } catch(error){$('#connection-backup-error').textContent=error.message;}
  finally{busy=false;buttons.forEach(button=>button.disabled=false);renderDatabasePicker();}
};
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
  if(!resultsGrid.confirmDiscard())return;
  if (busy || !profile || $('#credentials-dialog').open) return;
  if (!supportedEngines.includes(profile.engine)) return notify('Este motor todavía no tiene driver integrado.');
  try {
    const overview = await api.connectionOverview();
    if (overview.sessions.some(state => state.profileId === profile.id && state.connected)) return activateSaved(profile.id);
    await task(() => connectSavedOrPrompt(profile));
  } catch (error) { notify(error.message); }
}
async function connectSavedOrPrompt(profile, resumeTab=null) {
  const status = await api.credentialStatus(profile.id);
  if (status.saved) {
    let data;
    try { data = await api.connectProfile(profile.id, null, true); }
    catch (error) {
      await openCredentials(profile, resumeTab);
      $('#credentials-message').textContent = 'No se pudo conectar con la contraseña guardada. ' + error.message;
      return false;
    }
    await finishRemoteConnection(profile.id, data, resumeTab);
    return true;
  }
  await openCredentials(profile, resumeTab);
  return false;
}
async function finishRemoteConnection(id, data, resumeTab=null) {
  const resume=tabs.find(tab=>tab.id===(resumeTab||activeTab)&&tab.connectionKey===id);
  updateConnection(data);
  $('#results').replaceChildren(element('div', 'Sesión abierta. Ejecuta una consulta para ver sus resultados.', 'result-placeholder'));
  $('#query-info').textContent = 'Listo para ejecutar';
  if(resume){bindQuery(resume,data);await selectTab(resume.id,true);}else newQuery(initialQuery(data.engine));
  notify(`Conectado a ${data.name}${data.warning ? '. ' + data.warning : ''}`);
}
async function openCredentials(profile,resumeTab=null) {
  credentialProfile = profile;
  credentialResumeTab=resumeTab;
  $('#connection-password').value = '';
  const status = await api.credentialStatus(profile.id);
  $('#remember-password').checked = status.saved;
  $('#remember-password').disabled = !status.available;
  $('#connection-password').placeholder = status.saved ? 'Dejar vacío para usar la contraseña guardada' : '';
  $('#credentials-hint').textContent = status.available ? 'Opcional: la contraseña se guarda cifrada con la protección de este equipo.' : 'El almacenamiento seguro no está disponible en este equipo.';
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
    const input = $('#connection-password').value;
    const saved = (await api.credentialStatus(id)).saved;
    const password = !input && saved ? null : input;
    if (testOnly) {
      await api.testProfile(id, password);
      $('#credentials-message').textContent = 'Conexión correcta. Puedes conectar con esta configuración.';
    } else {
      const resumeTab=credentialResumeTab;
      const data = await api.connectProfile(id, password, $('#remember-password').checked);
      $('#connection-password').value = '';
      dialog.close(); credentialProfile = null;
      await finishRemoteConnection(id, data, resumeTab);
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
  if(!resultsGrid.confirmDiscard())return;
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
