import {attachSQLHighlight,renderSQLCode} from './sql-highlight.js';
export function createComparisonEditor({api,notify,onApplied}){
 const dialog=document.createElement('dialog');dialog.id='comparison-edit-dialog';
 dialog.innerHTML='<h2 id="comparison-edit-heading">Editar desde comparación</h2><p id="comparison-edit-target"></p><p id="comparison-edit-origin"></p><div id="comparison-edit-fields"><div id="comparison-edit-trigger"><label>Momento<select id="comparison-edit-timing"><option>BEFORE</option><option>AFTER</option></select></label><label>Evento<select id="comparison-edit-event"><option>INSERT</option><option>UPDATE</option><option>DELETE</option></select></label></div><label id="comparison-edit-label" for="comparison-edit-source">Definición</label><textarea id="comparison-edit-source" spellcheck="false" wrap="off"></textarea></div><div id="comparison-edit-review" hidden><ul id="comparison-edit-warnings"></ul><pre id="comparison-edit-sql"></pre></div><p id="comparison-edit-message" role="status"></p><div class="comparison-edit-actions"><button id="comparison-edit-close" class="secondary">Cerrar</button><button id="comparison-edit-preview" class="secondary">Revisar SQL</button><button id="comparison-edit-apply" class="primary" disabled>Aplicar</button></div>';
 document.body.append(dialog);const $=selector=>dialog.querySelector(selector),source=$('#comparison-edit-source'),highlight=attachSQLHighlight(source,{dialect:'mysql'});
 let context=null,review=null,pending=false,initial=null;
 function controls(){$('#comparison-edit-fields').inert=pending;$('#comparison-edit-close').disabled=pending;$('#comparison-edit-preview').disabled=pending;$('#comparison-edit-apply').disabled=pending||!review;}
 function invalidate(){review=null;$('#comparison-edit-review').hidden=true;controls();}
 function value(){return {text:source.value,timing:$('#comparison-edit-timing').value,event:$('#comparison-edit-event').value};}
 async function task(action){if(pending)return;pending=true;controls();try{await action();}catch(error){$('#comparison-edit-message').textContent=error.message;if(!dialog.open)notify(error.message);}finally{pending=false;controls();}}
 async function open(target,other=null){
  if(dialog.open||pending)return;
  await task(async()=>{
   const result=await api.openComparisonEdit({target,source:other});context=result;review=null;
   $('#comparison-edit-heading').textContent='Editar '+({trigger:'trigger',view:'vista',procedure:'procedimiento',function:'función'}[result.target.type]);
   $('#comparison-edit-target').textContent=`DESTINO: ${result.target.connection} · ${result.target.schema}.${result.target.name}${result.target.table?' · Tabla: '+result.target.table:''}`;
   $('#comparison-edit-origin').textContent=other?'Borrador tomado del otro lado. Conserva el nombre y el DEFINER de destino. Revisa las referencias a esquemas dentro del código antes de aplicar.':'Edición manual. Escribir y revisar el SQL todavía no modifica el servidor.';
   const trigger=result.target.type==='trigger';$('#comparison-edit-trigger').hidden=!trigger;
   $('#comparison-edit-label').textContent=trigger?'Cuerpo del trigger (BEGIN…END). Se conserva la tabla y el nombre del destino.':'Definición completa. Conserva el nombre, esquema y DEFINER del destino.';
   source.value=result.text;$('#comparison-edit-timing').value=result.timing||'BEFORE';$('#comparison-edit-event').value=result.event||'INSERT';
   initial=JSON.stringify(value());$('#comparison-edit-review').hidden=true;$('#comparison-edit-message').textContent=trigger?`DEFINER conservado: ${result.definer}. Momento y evento iniciales: los del destino.`:'Se guardará la definición original antes de aplicar.';
   dialog.showModal();highlight.refresh();source.focus();
  });
 }
 source.addEventListener('input',invalidate);for(const id of ['#comparison-edit-timing','#comparison-edit-event'])$(id).onchange=invalidate;
 $('#comparison-edit-preview').onclick=()=>task(async()=>{
  if(!context)return;invalidate();review=await api.previewComparisonEdit({token:context.token,...value()});
  renderSQLCode($('#comparison-edit-sql'),review.sql);$('#comparison-edit-warnings').replaceChildren();
  for(const warning of review.warnings||[]){const li=document.createElement('li');li.textContent=warning;$('#comparison-edit-warnings').append(li);}
  $('#comparison-edit-review').hidden=false;$('#comparison-edit-message').textContent=`Revisa el SQL. Aplicar modificará únicamente ${context.target.connection} · ${context.target.schema}.${context.target.name}.`;
 });
 $('#comparison-edit-apply').onclick=()=>task(async()=>{
  if(!review||!context)return;const request={token:context.token,reviewToken:review.reviewToken};invalidate();
  const result=await api.applyComparisonEdit(request);
  if(result.object||result.applied)await onApplied(result);
  if(result.applied){dialog.close();disposeContext();notify(result.warning||'Cambios aplicados en el destino y comparación actualizada.');}
  else $('#comparison-edit-message').textContent=`${result.error||'No se aplicaron los cambios.'}${result.backupPath?'\nCopia original: '+result.backupPath:''}${result.uncertain?'\nEl resultado es incierto. Verifica el objeto antes de reintentar.':''}`;
 });
 function disposeContext(){if(context)api.closeComparisonEdit(context.token).catch(()=>{});context=null;review=null;source.value='';}
 function close(){if(pending)return;if((context?.fromOther||JSON.stringify(value())!==initial)&&!confirm('¿Cerrar y descartar este borrador sin aplicarlo?'))return;dialog.close();disposeContext();}
 $('#comparison-edit-close').onclick=close;dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 dialog.addEventListener('close',()=>{if(!dialog.open)disposeContext();});
 return {open};
}
