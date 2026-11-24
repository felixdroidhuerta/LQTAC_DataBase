import {createEditDiagnostics} from './edit-diagnostics.js';
const make=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
export function createResultEditor({root,api,notify,runTask,onStatus,getOutput,getIndex,render,getVisibleRows,getSelectedRows,resetSelection,selectCell,getQueryContext,revealCell}){
  const col=td=>td.dataset.column!==undefined?Number(td.dataset.column):td.cellIndex;
  const selectedRows=()=>[...new Set(getSelectedRows?getSelectedRows():(active?[active.row]:[]))];
  const toolbar=document.querySelector('.results-header .mini-tools'),states=new Map();let active=null,input=null,drag=null,saving=false,opening=false;
  const diagnostics=createEditDiagnostics({api,notify,revealCell:(row,column,info)=>{if(getOutput()!==info.output||getIndex()!==info.index){notify('La respuesta ha cambiado. Vuelve a abrir la consulta indicada.');return;}revealCell?.(row,column);}});
  const status=make('span','','data-edit-status');status.id='data-edit-status';document.querySelector('.results-header .heading-tools').append(status);
  const audit=make('dialog',undefined,'data-change-sql-dialog');audit.innerHTML='<h2></h2><p class="data-change-status"></p><p class="designer-help">Este es el SQL de auditoría. dbFox añade comprobaciones de concurrencia para evitar sobrescribir una fila que haya cambiado desde la consulta.</p><pre></pre><div class="form-actions"><button type="button" class="secondary">Cerrar</button></div>';document.body.append(audit);audit.querySelector('button').onclick=()=>audit.close();
  const confirmApply=make('button','Aplicar','primary');
  confirmApply.type='button';confirmApply.id='confirm-result-changes';confirmApply.hidden=true;
  audit.querySelector('.form-actions').append(confirmApply);
  function reviewChanges(preview,request,state){
    audit.querySelector('h2').textContent='Revisar cambios antes de aplicar';
    const message=audit.querySelector('.data-change-status');
    message.textContent='Cambios pendientes de ejecutar en el servidor.';
    if(request.deletes?.length){
      const identities=request.deletes.map(row=>state.columns.map((column,index)=>column.primary?`${column.name}=${String(state.base[row][index])}`:null).filter(Boolean).join(', '));
      audit.querySelector('h2').textContent='Confirmar eliminación de filas';
      message.textContent=`Se eliminarán ${request.deletes.length} filas de ${state.target}. Filas seleccionadas: ${identities.slice(0,100).join(' · ')}${identities.length>100?' · Consulta el SQL para ver todas las filas.':''}`;
    }
    message.classList.remove('data-change-failed');
    audit.querySelector('pre').textContent=preview.statements.join('\n\n');
    confirmApply.hidden=false;
    return new Promise(resolve=>{
      let confirmed=false;
      confirmApply.onclick=()=>{confirmed=true;audit.close();};
      audit.onclose=()=>{confirmApply.hidden=true;confirmApply.onclick=null;audit.onclose=null;resolve(confirmed);};
      audit.showModal();
    });
  }
  const button=(id,text,label,action)=>{const node=make('button',text,'mini-tool');node.id=id;node.type='button';node.setAttribute('aria-label',label);node.dataset.hint=label;node.onclick=action;toolbar.append(node);return node;};
  const edit=button('edit-result-data','✎ Editar datos','Editar registros de la tabla',()=>open());
  const add=button('add-result-row','＋ Añadir fila','Añadir una fila pendiente. Activa la edición si todavía no está abierta.',()=>addRow());
  const remove=button('delete-result-row','− Quitar fila','Eliminar las filas seleccionadas. Las filas nuevas sin aplicar se quitan al momento; las existentes se borran tras revisar y confirmar su SQL',()=>deleteRow());
  const apply=button('apply-result-data','✓ Aplicar cambios','Guardar en la tabla los cambios pendientes',()=>save());
  const discard=button('discard-result-data','↶ Descartar','Descartar los cambios pendientes de este resultado',()=>reset());
  const nullButton=button('null-result-cell','NULL','Asignar NULL real a la celda seleccionada',()=>{const s=current();if(active&&s?.columns[active.column].nullable){stage(active.row,active.column,null);render();}});
  const current=()=>states.get(getIndex());const result=()=>getOutput()?.results[getIndex()];
  const changes=s=>[...(s?.changes||[])].map(([key,value])=>{const [row,column]=key.split(':').map(Number);return{row,column,value};});
  const pending=s=>s?s.changes.size+s.deleted.size+s.newRows.size:0;
  const editable=(s,row,column)=>!s?.deleted.has(row)&&(s?.newRows.has(row)?s.columns[column]?.insertable:s?.columns[column]?.editable);
  const cell=(row,column)=>root.querySelector(`tr[data-row-index="${row}"]>td[data-column="${column}"]`)||root.querySelector(`tr[data-row-index="${row}"]`)?.cells[column];
  function hasChanges(){return [...states.values()].some(s=>pending(s));}
  function sync(){
    const s=current(),data=result();
    edit.disabled=saving||opening||!data?.editContext;
    edit.setAttribute('aria-pressed',String(!!s?.enabled));
    edit.dataset.hint=data?.editContext?'Editar datos · Doble clic o F2 para editar una celda. Los cambios se guardan al pulsar Aplicar cambios':'Edición disponible en SELECT * de una tabla con clave primaria · MySQL, MariaDB, PostgreSQL y SQLite';
    add.disabled=saving||opening||!data?.editContext||!!s?.invalid;
    remove.disabled=saving||opening||!data?.editContext||!selectedRows().length||!!s?.invalid;
    apply.disabled=saving||!pending(s)||!!s?.invalid;
    discard.disabled=saving||!pending(s);
    nullButton.disabled=saving||!s?.enabled||!active||!editable(s,active.row,active.column)||!s.columns[active.column]?.nullable;
    status.textContent=opening?'Preparando edición de la tabla…':saving?'Preparando cambios…':s?`${s.target} · ${pending(s)} cambios pendientes${s.invalid?' · vuelve a consultar':''}`:'';
    root.classList.toggle('data-edit-mode',!!s?.enabled);
    document.dispatchEvent(new Event('lqtac:data-changed'));
  }
  async function open(){if(saving||opening)return;const existing=current();if(existing){existing.enabled=!existing.enabled;render();return;}const output=getOutput(),index=getIndex();if(!output?.results[index]?.editContext)return;opening=true;sync();try{await runTask(async()=>{const info=await api.openResultEdit(output.exportToken,index);if(getOutput()!==output||getIndex()!==index)return;states.set(index,{...info,base:structuredClone(result().values),changes:new Map(),newRows:new Set(),deleted:new Set(),enabled:true,invalid:false});render();notify('Edición de datos activada. Los cambios se guardan al pulsar Aplicar cambios.');});}finally{opening=false;sync();}}
  async function openCell(td,initial){if(!td||saving||opening||!result()?.editContext)return;const output=getOutput(),index=getIndex(),row=Number(td.parentElement.dataset.rowIndex),column=col(td);if(!current()?.enabled)await open();if(getOutput()!==output||getIndex()!==index||!current()?.enabled)return;if(!editable(current(),row,column)){notify('Esta columna es de solo lectura.');return;}start(cell(row,column),initial);}
  function stage(row,column,value){const s=current();if(!s?.enabled||saving||!editable(s,row,column))return;
    const metadata=s.columns[column];
    if(metadata.nullable&&typeof value==='string'&&(value===''||value.trim().toUpperCase()==='NULL'||(value.trim()===''&&/^(?:tinyint|smallint|mediumint|int|integer|bigint|smallserial|serial|bigserial|decimal|numeric|real|float|double)\b/i.test(metadata.type))))value=null;
    const base=s.base[row][column],same=!s.newRows.has(row)&&(value===null?base===null:base!==null&&String(value)===String(base));const key=`${row}:${column}`;if(same){s.changes.delete(key);result().values[row][column]=base;}else{s.changes.set(key,value);result().values[row][column]=value;}sync();}
  async function ensureEditing(){if(!current()?.enabled)await open();return current()?.enabled&&!current().invalid;}
  async function addRow(values){if(!await ensureEditing())return;const s=current(),row=result().values.length,blank=s.columns.map(()=>null);s.newRows.add(row);s.base.push([...blank]);result().values.push([...blank]);if(values)values.forEach((value,column)=>{const c=s.columns[column];if(c.insertable&&!c.auto)stage(row,column,value);});render();notify(values?'Fila pegada. Revisa los valores y pulsa Aplicar cambios. Para un NULL real usa el botón NULL.':'Fila nueva preparada. Los campos sin valor usan el valor predeterminado de la tabla.');}
  function shiftRows(s,row){s.base.splice(row,1);result().values.splice(row,1);s.newRows=new Set([...s.newRows].filter(i=>i!==row).map(i=>i>row?i-1:i));s.deleted=new Set([...s.deleted].filter(i=>i!==row).map(i=>i>row?i-1:i));s.changes=new Map([...s.changes].map(([key,value])=>{const [r,c]=key.split(':').map(Number);return r===row?null:[`${r>row?r-1:r}:${c}`,value];}).filter(Boolean));active=null;}
  async function deleteRow(){
    if(saving||opening)return;
    try{
    commit();
    const rows=selectedRows();
    if(!rows.length){notify('Selecciona una o varias filas para quitarlas.');return;}
    if(!await ensureEditing())return;
    const s=current();
    const fresh=rows.filter(row=>s.newRows.has(row)).sort((a,b)=>b-a);
    const existing=rows.filter(row=>!s.newRows.has(row)&&s.base[row]).map(row=>row-fresh.filter(item=>item<row).length);
    if(fresh.length){for(const row of fresh)shiftRows(s,row);resetSelection?.();render();sync();notify(`${fresh.length===1?'Fila nueva quitada':fresh.length+' filas nuevas quitadas'} antes de aplicarse. No se ha enviado nada al servidor.`);}
    if(existing.length&&await save({token:s.token,changes:[],inserts:[],deletes:existing})){resetSelection?.();render();}
    }catch(error){notify(error.message);}
  }
  function select(td,event){if(!td)return;selectCell?.(td,false,event);active={row:Number(td.parentElement.dataset.rowIndex),column:col(td)};root.querySelectorAll('.data-fill-handle').forEach(node=>node.remove());const s=current();if(s?.enabled&&editable(s,active.row,active.column)&&!saving&&!input){const handle=make('button','','data-fill-handle');handle.type='button';handle.setAttribute('aria-label','Autorrellenar columna');handle.title='Arrastra para copiar el valor. Doble clic: rellenar esta columna en todas las filas visibles.';td.append(handle);}sync();}
  function start(td,initial){const s=current(),row=Number(td?.parentElement?.dataset.rowIndex);if(!td||!s?.enabled||!editable(s,row,col(td))||saving)return;commit();select(td);const column=col(td),value=result().values[row][column];const editor=make('textarea',undefined,'data-cell-input');editor.rows=1;editor.wrap='off';editor.value=initial===undefined?(value===null?'':String(value)):initial;editor.placeholder=value===null?(s.newRows.has(row)?'Valor predeterminado':'NULL (valor nulo)'):'';editor.setAttribute('aria-label','Editar '+s.columns[column].name);input={editor,row,column};td.classList.add('data-cell-editing');td.append(editor);editor.focus();editor.setSelectionRange(editor.value.length,editor.value.length);editor.onblur=()=>commit();}
  function commit(cancel=false){if(!input)return;const editing=input;input=null;if(!cancel)stage(editing.row,editing.column,editing.editor.value);render();}
  function fill(rows,column,value){for(const row of rows)stage(row,column,value);render();notify(`Valor copiado a ${rows.length} filas visibles. Cambios pendientes de aplicar.`);}
  function reset(){commit(true);const s=current();if(!s)return;for(const row of [...s.newRows].sort((a,b)=>b-a))shiftRows(s,row);result().values=structuredClone(s.base);s.changes.clear();s.deleted.clear();render();}
  function detach(){commit(true);states.clear();active=null;input=null;}
  function snapshot(){commit();return [...states.entries()].map(([index,s])=>({index,...s,base:structuredClone(s.base),changes:[...s.changes],newRows:[...s.newRows],deleted:[...s.deleted]}));}
  function restore(saved){states.clear();for(const item of saved||[]){if(!Number.isInteger(item?.index)||!Array.isArray(item.base)||!Array.isArray(item.changes))continue;states.set(item.index,{...item,base:structuredClone(item.base),changes:new Map(item.changes),newRows:new Set(item.newRows||[]),deleted:new Set(item.deleted||[])});}active=null;}
  function requestFor(s){const all=changes(s);return {token:s.token,changes:all.filter(c=>!s.newRows.has(c.row)),deletes:[...s.deleted],inserts:[...s.newRows].map(row=>({row,values:all.filter(c=>c.row===row).map(({column,value})=>({column,value}))}))};}
  function showSQL(preview,response){const applied=response.applied.length+(response.deleted||[]).length+(response.inserted||[]).length,requested=preview.statements.length,title=audit.querySelector('h2'),status=audit.querySelector('.data-change-status');title.textContent=response.error?'Cambios aplicados parcialmente':'Cambios aplicados a la tabla';status.textContent=response.error?`Se aplicaron ${applied} de ${requested} cambios. El resto no se aplicó: ${response.error}`:`Se aplicaron correctamente ${applied} cambio${applied===1?'':'s'} en la base de datos.`;status.classList.toggle('data-change-failed',!!response.error);audit.querySelector('pre').textContent=preview.statements.join('\n\n');if(!audit.open)audit.showModal();if(response?.error)notify(`Aplicación parcial: ${response.error}`);}
  async function save(deleteRequest=null){
    commit();
    const s=current(),data=result();
    if((!deleteRequest&&!pending(s))||saving||s?.invalid||audit.open)return;
    const request=deleteRequest||requestFor(s);
    const output=getOutput(),query=getQueryContext?.()||{},info={output,index:getIndex(),query:query.name,response:data.label||'Respuesta '+(getIndex()+1),server:output?.source?.connection||query.connection,target:s?.target,sql:data.sql||output?.sql||query.sql||''};
    let preview,didApply=false,phase='preview';
    saving=true;sync();
    try{
      preview=await api.previewResultEdits(request);
      if(preview.error){diagnostics.show({info,error:preview.error,diagnostics:preview.diagnostics});return;}
      if(current()!==s||result()!==data)throw Error('La respuesta ha cambiado. Vuelve a revisar los cambios.');
      if(!await reviewChanges(preview,request,s))return;
      if(current()!==s||result()!==data)throw Error('La respuesta ha cambiado. Vuelve a revisar los cambios.');
      const unsubscribe=api.onResultEditProgress(item=>{
        if(item.token===s.token)status.textContent=`${s.target} · Aplicando ${item.completed}/${item.total} filas…`;
      });
      try{
        await runTask(async()=>{
          try{
          phase='apply';
          const response=await api.applyResultEdits(request);
          didApply=!!(response.applied.length+(response.inserted||[]).length+(response.deleted||[]).length);
          onStatus?.(response);
          for(const item of response.applied){
            data.values[item.row]=item.values;s.base[item.row]=structuredClone(item.values);
            for(const key of [...s.changes.keys()])if(key.startsWith(item.row+':'))s.changes.delete(key);
          }
          for(const item of response.inserted||[]){
            data.values[item.row]=item.values;s.base[item.row]=structuredClone(item.values);s.newRows.delete(item.row);
            for(const key of [...s.changes.keys()])if(key.startsWith(item.row+':'))s.changes.delete(key);
          }
          for(const row of response.deleted||[])shiftRows(s,row);
          s.invalid=response.requiresReload;
          if(response.error)diagnostics.show({info,error:response.error,diagnostics:response.errorDetails,applied:response.applied.length+(response.inserted||[]).length+(response.deleted||[]).length,requiresReload:response.requiresReload});
          else notify(`${response.applied.length} filas actualizadas · ${(response.inserted||[]).length} añadidas · ${(response.deleted||[]).length} borradas.`);
          }catch(error){diagnostics.show({info,error:error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,''),diagnostics:{phase,issues:[{reason:error.message}]}});}
        });
      }finally{unsubscribe();}
    }catch(error){const message=error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'');diagnostics.show({info,error:message,diagnostics:{phase,issues:[{reason:message}]}});}
    finally{saving=false;render();sync();}
    return didApply;
  }
  root.addEventListener('click',event=>{if(event.target.closest('.data-cell-input,.data-fill-handle'))return;const td=event.target.closest('tbody td');if(td)select(td,event);},true);
  root.addEventListener('contextmenu',event=>{if(event.target.closest('input,textarea,.data-fill-handle'))return;const td=event.target.closest('tbody td');if(td&&!td.parentElement.classList.contains('cell-row-selected'))select(td,event);},true);
  root.addEventListener('dblclick',event=>{const s=current();if(saving||opening)return;const handle=event.target.closest('.data-fill-handle');const td=event.target.closest('tbody td');if(handle&&active&&s?.enabled){event.preventDefault();event.stopImmediatePropagation();fill(getVisibleRows(),active.column,result().values[active.row][active.column]);return;}if(td&&!event.target.closest('.data-cell-input')&&result()?.editContext){event.preventDefault();event.stopImmediatePropagation();if(s?.enabled&&editable(s,Number(td.parentElement.dataset.rowIndex),col(td)))start(td);else if(!s?.enabled)void openCell(td);else notify('Esta columna es de solo lectura.');}},true);
  root.addEventListener('keydown',event=>{
    const s=current();if(saving||opening)return;
    if(!s?.enabled){const td=event.target.closest('tbody td');if(td&&event.key==='F2'&&result()?.editContext){event.preventDefault();event.stopImmediatePropagation();void openCell(td);}return;}
    if(event.target.closest('.data-cell-input')){event.stopPropagation();if(event.key==='Escape'){event.preventDefault();commit(true);}else if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();const ref=input;commit();cell(ref.row,ref.column)?.focus();}else if(event.key==='Tab'){event.preventDefault();const ref=input;commit();const rows=getVisibleRows(),positions=rows.flatMap(row=>s.columns.map((c,column)=>editable(s,row,column)?{row,column}:null).filter(Boolean));const at=positions.findIndex(p=>p.row===ref.row&&p.column===ref.column),next=positions[at+(event.shiftKey?-1:1)];if(next)start(cell(next.row,next.column));}return;}
    const td=event.target.closest('tbody td');if(!td||!editable(s,Number(td.parentElement.dataset.rowIndex),col(td)))return;
    if(['Enter','F2'].includes(event.key)||event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();event.stopImmediatePropagation();start(td,['Enter','F2'].includes(event.key)?undefined:event.key);}
  },true);
  root.addEventListener('pointerdown',event=>{const handle=event.target.closest('.data-fill-handle');if(!handle||!active||saving)return;event.preventDefault();event.stopImmediatePropagation();const rows=getVisibleRows();drag={rows,column:active.column,start:rows.indexOf(active.row),end:rows.indexOf(active.row),value:result().values[active.row][active.column],pointer:event.pointerId};try{root.setPointerCapture(event.pointerId);}catch{}},true);
  window.addEventListener('pointermove',event=>{if(!drag)return;const rect=root.getBoundingClientRect();if(event.clientY>rect.bottom-24)root.scrollTop+=18;else if(event.clientY<rect.top+24)root.scrollTop-=18;const td=document.elementFromPoint(event.clientX,event.clientY)?.closest('tbody td');if(!td||!root.contains(td))return;const at=drag.rows.indexOf(Number(td.parentElement.dataset.rowIndex));if(at<0)return;drag.end=at;root.querySelectorAll('.data-fill-preview').forEach(node=>node.classList.remove('data-fill-preview'));for(const row of drag.rows.slice(Math.min(drag.start,at),Math.max(drag.start,at)+1))cell(row,drag.column)?.classList.add('data-fill-preview');});
  function endDrag(cancel=false){if(!drag)return;const ref=drag;drag=null;try{root.releasePointerCapture(ref.pointer);}catch{}root.querySelectorAll('.data-fill-preview').forEach(node=>node.classList.remove('data-fill-preview'));if(!cancel&&ref.start!==ref.end)fill(ref.rows.slice(Math.min(ref.start,ref.end),Math.max(ref.start,ref.end)+1),ref.column,ref.value);}
  window.addEventListener('pointerup',()=>endDrag());window.addEventListener('pointercancel',()=>endDrag(true));
  document.addEventListener('lqtac:sync-copy',sync);
  return {
    async prepareEdit(td){
      const output=getOutput(),index=getIndex(),row=Number(td?.parentElement?.dataset.rowIndex),column=td?col(td):-1;
      if(!result()?.editContext)throw Error('Este resultado es de solo lectura. Consulta una tabla con clave primaria para editarla.');
      if(!await ensureEditing()||getOutput()!==output||getIndex()!==index)throw Error('No se pudo activar la edición de esta respuesta.');
      const state=current();
      if(!editable(state,row,column))throw Error('Este campo es de solo lectura.');
      return value=>{
        if(getOutput()!==output||getIndex()!==index||current()!==state||state.invalid||saving)throw Error('La respuesta ha cambiado. Abre de nuevo el contenido de la celda.');
        stage(row,column,value);render();
      };
    },
    hasChanges, snapshot, restore, detach, pasteRows:async rows=>{for(const values of rows)await addRow(values);},
    viewResult(){const s=current();return s?{...result(),values:s.base}:result();},
    confirmDiscard(){if(!hasChanges())return true;if(!confirm('Hay cambios de datos pendientes. ¿Descartarlos para continuar?'))return false;for(const [index,s]of states){const data=getOutput()?.results[index];if(data)data.values=s.base.filter((_,i)=>!s.newRows.has(i)).map(row=>structuredClone(row));s.changes.clear();s.newRows.clear();s.deleted.clear();}return true;},
    reset(){commit(true);states.clear();active=null;sync();},
    canClose(index){const s=states.get(index);if(!pending(s))return true;if(!confirm('Esta pestaña tiene cambios sin aplicar. ¿Descartarlos y cerrarla?'))return false;const data=getOutput().results[index];data.values=s.base.filter((_,i)=>!s.newRows.has(i)).map(row=>structuredClone(row));s.changes.clear();s.newRows.clear();s.deleted.clear();return true;},
    decorate(){const s=current();for(const row of root.querySelectorAll('tbody tr')){const rowIndex=Number(row.dataset.rowIndex);row.classList.toggle('data-row-new',!!s?.newRows.has(rowIndex));row.classList.toggle('data-row-deleted',!!s?.deleted.has(rowIndex));for(const td of row.querySelectorAll(':scope>td')){const key=`${rowIndex}:${col(td)}`,can=editable(s,rowIndex,col(td));td.classList.toggle('data-cell-dirty',!!s?.changes.has(key));td.classList.toggle('data-cell-readonly',!!s?.enabled&&!can);if(s?.newRows.has(rowIndex)&&!s.changes.has(key)){td.querySelector('.cell-value').textContent='DEFAULT';td.copyValue='';}if(s?.enabled)td.title=can?'Doble clic o F2 para editar. Los cambios requieren Aplicar.':'Campo de solo lectura o fila marcada para borrar.';}}if(active){const td=cell(active.row,active.column);if(td)select(td);}sync();},
  };
}
