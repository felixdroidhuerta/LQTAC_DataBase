export function initSQLFiles({api,runTask,getDocument,onOpen,onSaved,notify,isBusy}){
  const tools=document.querySelector('.editor-caption .mini-tools');
  function button(id,text,label,action){const item=document.createElement('button');item.id=id;item.className='mini-tool';item.textContent=text;item.setAttribute('aria-label',label);item.dataset.hint=label;item.onclick=action;return item;}
  const open=()=>runTask(async()=>{const file=await api.openSQL();if(file){onOpen(file);notify('Archivo SQL abierto. No se ha ejecutado.');}});
  const save=saveAs=>runTask(async()=>{const tab=getDocument();if(!tab)return notify('Abre una consulta primero.');const id=tab.id,sql=tab.sql;const file=await api.saveSQL({id:tab.sqlFileId,sql,saveAs});if(file){onSaved(id,file,sql);notify('Archivo SQL guardado.');}});
  tools.prepend(button('open-sql-file','▤','Abrir archivo SQL · Ctrl+O',open),button('save-sql-file','▣','Guardar archivo SQL · Ctrl+S',()=>save(false)),button('save-sql-as','▣+','Guardar SQL como… · Ctrl+Mayús+S',()=>save(true)));
  document.addEventListener('keydown',event=>{if(event.defaultPrevented||document.querySelector('dialog[open]')||!(event.ctrlKey||event.metaKey)||isBusy())return;if(event.key.toLowerCase()==='o'){event.preventDefault();open();}if(event.key.toLowerCase()==='s'){event.preventDefault();save(event.shiftKey);}});
}
