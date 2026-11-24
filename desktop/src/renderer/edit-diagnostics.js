const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
const valueText=value=>value===null?'NULL':value===undefined?'No enviado':typeof value==='string'?(value===''?'"" (texto vacío)':value):JSON.stringify(value);
const operationName={update:'Actualizar',insert:'Añadir fila',delete:'Borrar fila'};
export function createEditDiagnostics({api,notify,revealCell}){
 const dialog=node('dialog',undefined,'edit-diagnostics-dialog');dialog.id='edit-diagnostics-dialog';
 const heading=node('h2'),summary=node('p'),context=node('p',undefined,'edit-error-context'),list=node('div',undefined,'edit-error-list'),source=node('details'),sourceTitle=node('summary','SQL que generó esta respuesta'),sourceCode=node('pre');source.append(sourceTitle,sourceCode);
 const actions=node('div',undefined,'form-actions'),copy=node('button','Copiar detalles','secondary'),close=node('button','Cerrar','primary');copy.type=close.type='button';close.onclick=()=>dialog.close();actions.append(copy,close);dialog.append(heading,summary,context,list,source,actions);document.body.append(dialog);let report=null;
 copy.onclick=async()=>{try{await api.writeClipboard(JSON.stringify(report,null,2));notify('Detalles del error copiados.');}catch(error){notify(error.message);}};
 function show({info,diagnostics,error,applied=0,requiresReload=false}){
  const {output,...contextInfo}=info;report={...contextInfo,error,applied,requiresReload,diagnostics};heading.textContent=diagnostics?.phase==='validation'?'Revisa los valores antes de aplicar':diagnostics?.phase==='preview'?'No se pudieron preparar los cambios':'No se pudieron completar los cambios';
  summary.textContent=diagnostics?.phase==='validation'?`${diagnostics.total} error(es) de validación. No se ha enviado ningún cambio al servidor.${diagnostics.total>diagnostics.issues.length?' Se muestran los primeros '+diagnostics.issues.length+'.':''}`:diagnostics?.phase==='preview'?'No se han enviado cambios al servidor. Los valores permanecen pendientes.':`${applied} fila(s) aplicadas antes del fallo. ${requiresReload?'Vuelve a consultar la tabla antes de continuar; el resultado de alguna operación puede requerir comprobación.':'Los cambios restantes siguen pendientes.'}`;
  context.textContent=`Consulta: ${info.query||'Sin nombre'} · Respuesta: ${info.response||'Sin nombre'} · Servidor: ${info.server||'Sin servidor'} · Tabla: ${info.target||'Sin identificar'}`;
  list.replaceChildren();const issues=diagnostics?.issues||[{reason:error}];
  for(const issue of issues){const card=node('section',undefined,'edit-error-item');
   const keys=(issue.keys||[]).filter(k=>k.value!==undefined).map(k=>`${k.name}=${valueText(k.value)}`).join(' · ');
   card.append(node('strong',`${operationName[issue.operation]||'Preparar cambios'}${issue.rowNumber?' · Fila original '+issue.rowNumber:''}${keys?' · '+keys:''}`));
   card.append(node('p',issue.reason||error,'edit-error-reason'));
   if(issue.code||issue.sqlState||issue.constraint)card.append(node('p',[issue.code&&`Código: ${issue.code}`,issue.sqlState&&`SQLSTATE: ${issue.sqlState}`,issue.constraint&&`Restricción: ${issue.constraint}`,issue.serverColumn&&`Campo indicado por el servidor: ${issue.serverColumn}`].filter(Boolean).join(' · ')));
   if(issue.fields?.length){const table=node('table'),head=node('thead'),row=node('tr');for(const label of ['Campo y tipo','Valor original','Valor propuesto',''])row.append(node('th',label));head.append(row);table.append(head);const body=node('tbody');
    for(const field of issue.fields){const tr=node('tr');tr.append(node('td',`${field.name}${field.type?' · '+field.type:''}`));
     for(const value of [field.oldValue,field.newValue]){const cell=node('td');cell.append(node('pre',valueText(value)));tr.append(cell);}
     const cell=node('td');if(Number.isInteger(issue.rowIndex)&&Number.isInteger(field.columnIndex)&&!requiresReload){const button=node('button','Ir a celda','secondary');button.type='button';button.onclick=()=>{dialog.close();revealCell(issue.rowIndex,field.columnIndex,info);};cell.append(button);}tr.append(cell);body.append(tr);
    }table.append(body);card.append(table);
   }
   if(issue.sql){const sql=node('details'),title=node('summary','SQL de la modificación que falló'),pre=node('pre',issue.sql);sql.open=true;sql.append(title,pre);card.append(sql);}
   else if(diagnostics?.phase==='validation')card.append(node('small','No se ha generado SQL para este valor: primero hay que corregirlo.'));
   list.append(card);
  }
  sourceCode.textContent=info.sql||'No hay SQL disponible para esta respuesta.';source.open=false;if(!dialog.open)dialog.showModal();
 }
 return {show};
}
