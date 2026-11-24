import {compareObjects,diffLines} from './schema-diff.mjs';
import {renderSQLCode} from './sql-highlight.js';
import {createComparisonEditor} from './comparison-editor.js';
const labels={trigger:'Triggers',view:'Vistas',procedure:'Procedimientos',function:'Funciones'};
const states={equal:'Igual',modified:'Modificado','only-a':'Solo en A','only-b':'Solo en B',error:'No se pudo leer'};
const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
export function initSchemaCompare({api,notify}){
 const root=node('section',undefined,'view hidden');root.id='schema-compare';
 const heading=node('div',undefined,'compare-heading');heading.append(node('h2','Comparar bases de datos'),node('span','MySQL / MariaDB · Lectura de definiciones'));
 const targets=node('div',undefined,'compare-targets');
 const selects=[];
 for(const side of ['A','B']){
  const box=node('div',undefined,'compare-target');box.append(node('strong',`Lado ${side}`));
  const server=node('select'),schema=node('select');server.id=`compare-server-${side.toLowerCase()}`;schema.id=`compare-schema-${side.toLowerCase()}`;
  server.setAttribute('aria-label',`Servidor ${side}`);schema.setAttribute('aria-label',`Base de datos ${side}`);
  box.append(server,schema);targets.append(box);selects.push({server,schema});
 }
 const actions=node('div',undefined,'compare-actions'),refresh=node('button','↻ Conexiones','secondary'),load=node('button','Comparar','primary'),cancel=node('button','Detener','secondary'),exportButton=node('button','Exportar informe','secondary');
 refresh.id='compare-refresh';load.id='compare-load';cancel.id='compare-cancel';cancel.disabled=true;exportButton.id='compare-export';exportButton.disabled=true;
 actions.append(refresh,load,cancel,exportButton);targets.append(actions);
 const optionsRoot=node('div',undefined,'compare-options'),options={};
 for(const [key,text,checked]of [['ignoreWhitespace','Ignorar espacios y formato',true],['ignoreDefiner','Ignorar DEFINER',true],['ignoreSchema','Ignorar nombre de la base',true],['ignoreComments','Ignorar comentarios',false]]){
  const label=node('label'),input=node('input');input.type='checkbox';input.checked=checked;input.id='compare-'+key;options[key]=input;
  input.onchange=()=>reclassify();label.append(input,document.createTextNode(text));optionsRoot.append(label);
 }
 const status=node('p','Conecta dos sesiones MySQL/MariaDB, o elige dos bases del mismo servidor.','compare-status');status.id='compare-status';status.setAttribute('role','status');
 const warning=node('p','Los catálogos dependen de los permisos: un objeto no visible puede parecer ausente. Se compara código, no datos de las tablas.','compare-notice');
 const workspace=node('div',undefined,'compare-workspace'),index=node('aside',undefined,'compare-index');
 const search=node('input');search.type='search';search.placeholder='Buscar objeto…';search.id='compare-search';search.setAttribute('aria-label','Buscar objeto');
 const type=node('select');type.id='compare-type';type.setAttribute('aria-label','Tipo de objeto');
 const table=node('select');table.id='compare-table';table.setAttribute('aria-label','Filtrar triggers por tabla (A o B)');
 const state=node('select');state.id='compare-state';state.setAttribute('aria-label','Estado de comparación');
 const option=(select,value,text)=>{const item=node('option',text);item.value=value;select.append(item);};
 option(type,'','Todos los tipos');for(const [key,value]of Object.entries(labels))option(type,key,value);
 option(table,'','Todas las tablas (triggers)');table.disabled=true;
 option(state,'','Todos los estados');for(const [key,value]of Object.entries(states))option(state,key,value);
 const count=node('p','Sin comparación','compare-count'),list=node('div',undefined,'compare-list');list.id='compare-list';index.append(search,type,table,state,count,list);
 const detail=node('div',undefined,'compare-detail'),detailTitle=node('strong','Selecciona un objeto'),detailNote=node('p','El código original se muestra sin modificar; las opciones afectan al estado del objeto.','compare-notice');
 const tools=node('div',undefined,'compare-detail-tools'),previous=node('button','↑ Diferencia','secondary'),next=node('button','↓ Diferencia','secondary'),pageBack=node('button','‹','secondary'),pageNext=node('button','›','secondary'),position=node('span');
 previous.id='compare-previous';next.id='compare-next';pageBack.setAttribute('aria-label','Página de líneas anterior');pageNext.setAttribute('aria-label','Página de líneas siguiente');
 tools.append(previous,next,pageBack,position,pageNext);
 const panes=node('div',undefined,'compare-panes'),panels=[];
 for(const side of ['A','B']){
  const panel=node('div',undefined,'compare-pane'),header=node('div',undefined,'compare-pane-heading'),name=node('span',`Código ${side}`),choose=node('select'),copy=node('button','Copiar','secondary'),code=node('div',undefined,'compare-code');
  choose.id='compare-object-'+side.toLowerCase();choose.setAttribute('aria-label',`Objeto del lado ${side}`);code.id='compare-code-'+side.toLowerCase();code.tabIndex=0;code.setAttribute('aria-label',`Definición original ${side}`);
  const edit=node('button','Editar','secondary'),take=node('button',side==='A'?'B → A':'A → B','secondary');
  edit.id='compare-edit-'+side.toLowerCase();edit.title=`Editar manualmente el código del lado ${side}`;take.id='compare-take-'+side.toLowerCase();take.title=`Tomar el código del otro lado como borrador de ${side}`;edit.disabled=take.disabled=true;
  header.append(name,choose,copy,edit,take);panel.append(header,code);panes.append(panel);panels.push({choose,copy,edit,take,code,name});
 }
 const detailTables=node('p','','compare-trigger-tables');detailTables.id='compare-trigger-tables';detailTables.hidden=true;
 detail.append(detailTitle,detailTables,detailNote,tools,panes);workspace.append(index,detail);root.append(heading,targets,optionsRoot,status,warning,workspace);const main=document.querySelector('main');main.insertBefore(root,main.querySelector(':scope > footer'));
 let sessions=[],data=null,entries=[],selected=null,rows=[],changes=[],changeIndex=-1,page=0,running=false,runIds=[],generation=0;
 const editor=createComparisonEditor({api,notify,onApplied:async result=>{
  if(!result.object){status.textContent=result.warning||'Se aplicó el cambio, pero no se pudo recargar el objeto. Vuelve a comparar.';return;}
  for(const side of data||[])if(side.key===result.target.key&&side.schema===result.target.schema){const index=side.objects.findIndex(o=>o.name===result.target.name&&o.type===result.target.type);if(index>=0)side.objects[index]=result.object;side.loadedAt=new Date().toISOString();}
  reclassify();
 }});
 const currentSnapshot=()=>data&&selects.every((c,i)=>c.server.value===data[i].key&&c.schema.value===data[i].schema);
 function syncEditButtons(){const pair=currentPair();panels.forEach((panel,i)=>{panel.edit.disabled=running||!currentSnapshot()||!pair[i]?.ddl||!!pair[i]?.error;panel.take.disabled=panel.edit.disabled||!pair[1-i]?.ddl||!!pair[1-i]?.error;});}
 const settings=()=>Object.fromEntries(Object.entries(options).map(([key,input])=>[key,input.checked]));
 function schemaOptions(i){const controls=selects[i],old=controls.schema.value;controls.schema.replaceChildren();const session=sessions.find(s=>s.sessionKey===controls.server.value);
  for(const schema of session?.schemas||[])option(controls.schema,schema.name,schema.name);
  controls.schema.value=[...controls.schema.options].some(o=>o.value===old)?old:session?.database||controls.schema.options[0]?.value||'';
 }
 async function activate(){
  if(!api||running)return;
  try{const overview=await api.connectionOverview();sessions=overview.sessions.filter(s=>s.connected&&['mysql','mariadb'].includes(s.engine));
   selects.forEach((controls,i)=>{const old=controls.server.value;controls.server.replaceChildren();for(const session of sessions)option(controls.server,session.sessionKey,session.name);
    if(sessions.some(s=>s.sessionKey===old))controls.server.value=old;else if(sessions[i])controls.server.value=sessions[i].sessionKey;
    schemaOptions(i);
   });load.disabled=!sessions.length;
   if(!sessions.length)status.textContent='No hay sesiones MySQL/MariaDB conectadas. Conéctalas desde Conexiones y pulsa ↻ Conexiones.';
  }catch(error){status.textContent=error.message;}
 }
 selects.forEach((controls,i)=>controls.server.onchange=()=>{schemaOptions(i);if(data)status.textContent='Destino cambiado. Pulsa Comparar para cargarlo; el código mostrado sigue siendo la captura anterior.';syncEditButtons();});
 selects.forEach(controls=>controls.schema.onchange=()=>{if(data)status.textContent='Base cambiada. Pulsa Comparar para renovar la captura.';syncEditButtons();});
 refresh.onclick=activate;
 function lock(value){running=value;load.disabled=value||!sessions.length;refresh.disabled=value;cancel.disabled=!value;exportButton.disabled=value||!data;selects.forEach(c=>{c.server.disabled=value;c.schema.disabled=value;});syncEditButtons();}
 load.onclick=async()=>{
  if(running)return;
  const request=selects.map(c=>({key:c.server.value,schema:c.schema.value,runId:crypto.randomUUID()}));
  if(request.some(r=>!r.key||!r.schema)){status.textContent='Selecciona servidor y base en ambos lados.';return;}
  const turn=++generation;runIds=request.map(r=>r.runId);lock(true);status.textContent='Leyendo definiciones de A y B…';
  try{
   const results=await Promise.allSettled(request.map(r=>api.readComparison(r)));
   if(turn!==generation)return;
   const errors=results.map((r,i)=>r.status==='rejected'?`${i?'B':'A'}: ${r.reason.message}`:null).filter(Boolean);
   if(errors.length)throw Error(errors.join(' · '));
   data=results.map(r=>r.value);reclassify();
  }catch(error){if(turn===generation)status.textContent=error.message;}
  finally{if(turn===generation){runIds=[];lock(false);}}
 };
 cancel.onclick=async()=>{generation++;await Promise.allSettled(runIds.map(id=>api.cancelComparison(id)));runIds=[];lock(false);status.textContent='Comparación cancelada. Se conserva la captura anterior, si la había.';};
 function reclassify(){if(!data)return;entries=compareObjects(data[0].objects,data[1].objects,settings());
  const oldTable=table.value,names=[...new Set(data.flatMap(side=>side.objects.filter(o=>o.type==='trigger'&&o.table).map(o=>o.table)))].sort((a,b)=>a.localeCompare(b));
  table.replaceChildren();option(table,'','Todas las tablas (triggers)');for(const name of names)option(table,name,name);table.disabled=!names.length;
  if(names.includes(oldTable))table.value=oldTable;
  status.textContent=`${data[0].connection} / ${data[0].schema} ↔ ${data[1].connection} / ${data[1].schema} · ${entries.length} objetos · Captura ${new Date(data[0].loadedAt).toLocaleTimeString()}`;
  const visible=renderIndex(),entry=visible.find(e=>e.id===selected)||visible[0];if(entry)selectEntry(entry);else clearSelection();
 }
 function renderIndex(){
  list.replaceChildren();const term=search.value.toLocaleLowerCase(),filtered=entries.filter(e=>(!type.value||type.value===e.type)&&(!table.value||(e.type==='trigger'&&[e.left?.table,e.right?.table].includes(table.value)))&&(!state.value||state.value===e.status)&&[e.name,e.left?.table,e.right?.table].some(value=>value?.toLocaleLowerCase().includes(term)));
  count.textContent=`${filtered.length} de ${entries.length} · ${entries.filter(e=>e.status==='modified').length} modificados`;
  for(const kind of Object.keys(labels)){const items=filtered.filter(e=>e.type===kind);if(!items.length)continue;list.append(node('strong',`${labels[kind]} (${items.length})`));
   for(const entry of items){const button=node('button',undefined,'compare-object'+(selected===entry.id?' selected':''));button.dataset.status=entry.status;button.dataset.name=entry.name;button.dataset.type=entry.type;button.setAttribute('aria-pressed',String(selected===entry.id));
    button.append(node('span',entry.name),node('small',states[entry.status]));
    if(entry.type==='trigger'){const tables=entry.left?.table&&entry.left.table===entry.right?.table?`Tabla: ${entry.left.table}`:`A: ${entry.left?.table||'—'} · B: ${entry.right?.table||'—'}`;button.append(node('small',tables));button.title=tables;}
    button.onclick=()=>selectEntry(entry);list.append(button);}
  }
  return filtered;
 }
 function clearSelection(){selected=null;detailTitle.textContent='No hay objetos visibles con estos filtros';detailTables.hidden=true;detailNote.textContent='';panels.forEach(p=>{p.choose.replaceChildren();p.code.replaceChildren();p.copy.disabled=p.edit.disabled=p.take.disabled=true;});rows=[];changes=[];page=0;renderLines();}
 function applyFilters(){const filtered=renderIndex();if(!filtered.some(e=>e.id===selected)){if(filtered[0])selectEntry(filtered[0]);else clearSelection();}}
 for(const control of [search,state])control.addEventListener(control===search?'input':'change',applyFilters);
 table.onchange=()=>{if(table.value)type.value='trigger';applyFilters();};
 type.onchange=()=>{if(type.value&&type.value!=='trigger')table.value='';applyFilters();};
 function selectEntry(entry){selected=entry.id;renderIndex();
  panels.forEach((panel,i)=>{panel.choose.replaceChildren();option(panel.choose,'','Sin objeto');for(const item of data[i].objects.filter(item=>item.type===entry.type))option(panel.choose,JSON.stringify([item.type,item.name]),item.name);
   const object=i?entry.right:entry.left;panel.choose.value=object?JSON.stringify([object.type,object.name]):'';panel.name.textContent=`${i?'B':'A'} · ${data[i].connection} / ${data[i].schema}`;
  });showPair();
 }
 function currentPair(){return panels.map((panel,i)=>data?.[i].objects.find(item=>JSON.stringify([item.type,item.name])===panel.choose.value)||null);}
 function showPair(){const pair=currentPair();page=0;changeIndex=-1;
  detailTitle.textContent=pair.map((p,i)=>p?.name||`Sin objeto en ${i?'B':'A'}`).join(' ↔ ');
  detailTables.hidden=!pair.some(p=>p?.type==='trigger');
  detailTables.textContent=pair.map((p,i)=>`${i?'B':'A'} · Tabla: ${p?.table?`${p.tableSchema||p.schema}.${p.table}`:p?'no disponible':'sin objeto'}`).join(' ↔ ');
  const errors=pair.map((p,i)=>p?.error?`${i?'B':'A'}: ${p.error}`:null).filter(Boolean);
  const same=pair.every(p=>p&&!p.error)&&compareObjects([{...pair[0],name:'pair'}],[{...pair[1],name:'pair'}],settings())[0]?.status==='equal';
  detailNote.textContent=errors.length?errors.join(' · '):`${same?'Iguales con las opciones elegidas. ':''}Se muestra el código original. DEFINER, espacios o nombres de base ignorados pueden seguir resaltados aquí.${pair[0]?.sqlMode!==pair[1]?.sqlMode?' Los modos SQL difieren.':''}`;
  rows=diffLines(pair[0]?.ddl||'',pair[1]?.ddl||'');changes=rows.flatMap((r,index)=>r.kind==='equal'?[]:[index]);renderLines();syncEditButtons();
 }
 panels.forEach((panel,i)=>{panel.choose.onchange=showPair;panel.copy.onclick=async()=>{try{const item=currentPair()[i];if(item?.ddl){await api.writeClipboard(item.ddl);notify(`Código ${i?'B':'A'} copiado.`);}}catch(error){notify(error.message);}};});
 panels.forEach((panel,i)=>{
  const target=index=>{const item=currentPair()[index];return item?{key:data[index].key,schema:item.schema,name:item.name,type:item.type,expectedDDL:item.ddl}:null;};
  panel.edit.onclick=()=>{if(currentSnapshot()&&!running)editor.open(target(i));};
  panel.take.onclick=()=>{if(currentSnapshot()&&!running)editor.open(target(i),target(1-i));};
 });
 const pageSize=250;
 function renderLines(){
  const start=page*pageSize,end=Math.min(rows.length,start+pageSize);position.textContent=`Líneas ${rows.length?start+1:0}–${end} / ${rows.length} · ${changes.length} diferencias de línea`;
  pageBack.disabled=page===0;pageNext.disabled=end>=rows.length;previous.disabled=next.disabled=!changes.length;
  panels.forEach((panel,i)=>{const fragment=document.createDocumentFragment();
   rows.slice(start,end).forEach((row,index)=>{const line=node('div',undefined,`compare-line ${row.kind}`);line.dataset.row=start+index;
    const gutter=node('span',String((i?row.b:row.a)??''),'compare-line-number'),code=node('code');renderSQLCode(code,i?row.right:row.left);
    if(row.kind==='modified'){
     let from=0,suffix=0;while(from<row.left.length&&from<row.right.length&&row.left[from]===row.right[from])from++;
     while(suffix<row.left.length-from&&suffix<row.right.length-from&&row.left[row.left.length-1-suffix]===row.right[row.right.length-1-suffix])suffix++;
     const to=(i?row.right:row.left).length-suffix,walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT),texts=[];let offset=0,text;
     while((text=walker.nextNode())){texts.push({text,start:offset});offset+=text.length;}
     for(const {text,start}of texts){const lo=Math.max(0,from-start),hi=Math.min(text.length,to-start);if(hi<=lo)continue;
      const replacement=document.createDocumentFragment();replacement.append(document.createTextNode(text.data.slice(0,lo)),node('mark',text.data.slice(lo,hi),'compare-inline-change'),document.createTextNode(text.data.slice(hi)));text.replaceWith(replacement);}
    }
    line.append(gutter,code);fragment.append(line);});
   panel.code.replaceChildren(fragment);panel.code.scrollTop=0;panel.copy.disabled=!currentPair()[i]?.ddl;
  });
 }
 pageBack.onclick=()=>{page--;renderLines();};pageNext.onclick=()=>{page++;renderLines();};
 function moveDifference(delta){if(!changes.length)return;changeIndex=changeIndex<0?(delta>0?0:changes.length-1):(changeIndex+delta+changes.length)%changes.length;const row=changes[changeIndex];page=Math.floor(row/pageSize);renderLines();
  panels.forEach(panel=>{const line=panel.code.querySelector(`[data-row="${row}"]`);line?.classList.add('current-difference');if(line)panel.code.scrollTop=line.offsetTop;});
 }
 previous.onclick=()=>moveDifference(-1);next.onclick=()=>moveDifference(1);
 panels.forEach((panel,i)=>panel.code.onscroll=()=>{const other=panels[1-i].code;if(other.scrollTop!==panel.code.scrollTop)other.scrollTop=panel.code.scrollTop;if(other.scrollLeft!==panel.code.scrollLeft)other.scrollLeft=panel.code.scrollLeft;});
 exportButton.onclick=async()=>{try{if(data&&await api.exportComparison(JSON.stringify({format:'dbFox comparison',version:1,exportedAt:new Date().toISOString(),options:settings(),sources:data.map(({objects,...info})=>info),objects:entries},null,2)))notify('Informe de comparación exportado.');}catch(error){notify(error.message);}};
 return {activate};
}
