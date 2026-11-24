const node=(tag,text)=>{const item=document.createElement(tag);if(text!==undefined)item.textContent=text;return item;};
const text=cell=>cell.copyValue??cell.textContent;
const dataCells=row=>[...row.children].filter(cell=>cell.tagName==='TD');
const columnOf=cell=>cell.dataset.column!==undefined?Number(cell.dataset.column):dataCells(cell.parentElement).indexOf(cell);
const quote=(value,separator)=>value.includes(separator)||/[\r\n"]/.test(value)?'"'+value.replaceAll('"','""')+'"':value;
export function parseClipboardRows(input){
  const sample=input.split(/\r?\n/,1)[0],delimiter=sample.includes('\t')?'\t':sample.includes(';')?';':',';let rows=[],row=[],value='',quoted=false;
  for(let i=0;i<input.length;i++){const c=input[i];if(quoted){if(c==='"'&&input[i+1]==='"'){value+='"';i++;}else if(c==='"')quoted=false;else value+=c;}else if(c==='"'&&!value)quoted=true;else if(c===delimiter){row.push(value);value='';}else if(c==='\r'||c==='\n'){row.push(value);rows.push(row);row=[];value='';if(c==='\r'&&input[i+1]==='\n')i++;}else value+=c;}
  if(quoted)throw Error('El texto del portapapeles contiene comillas sin cerrar.');if(value||row.length)rows.push([...row,value]);return rows;
}
export function attachCellCopy(container,{api,notify,button,getColumns,onPasteRows,prepareEdit}={}){
  if(button)button.dataset.localAction='true';
  let selected=null,key=null,anchor=null,pasting=false;const selectedRows=new Set();const menu=node('div');menu.className='cell-copy-menu';menu.hidden=true;menu.setAttribute('role','menu');
  const detail=node('dialog');detail.className='cell-detail-dialog';const heading=node('h2','Contenido de la celda');const area=node('textarea');area.readOnly=true;area.wrap='off';area.setAttribute('aria-label','Contenido completo de la celda');const actions=node('div');const copy=node('button','Copiar contenido');copy.className='primary';const close=node('button','Cerrar');close.className='secondary';close.onclick=()=>detail.close();actions.append(close,copy);detail.append(heading,area,actions);document.body.append(menu,detail);
  const alive=()=>selected?.isConnected&&container.contains(selected);
  function sync(){if(button)button.disabled=!alive();}
  async function write(value){try{await api.writeClipboard(String(value));notify?.('Contenido copiado.');}catch(error){notify?.(error.message);}}
  function identify(cell){const row=cell.parentElement;return {row:row.dataset.copyRow??row.dataset.rowIndex,column:columnOf(cell)};}
  const visibleRows=()=>[...container.querySelectorAll('tbody tr')].map(item=>Number(item.dataset.rowIndex));
  function rowId(cell){return Number(cell.parentElement.dataset.rowIndex);}
  function paint(){for(const item of container.querySelectorAll('.cell-selected,.cell-row-selected'))item.classList.remove('cell-selected','cell-row-selected');if(selected?.isConnected){selected.classList.add('cell-selected');selected.tabIndex=0;}for(const id of selectedRows)container.querySelector(`tr[data-row-index="${id}"]`)?.classList.add('cell-row-selected');for(const tr of container.querySelectorAll('tbody tr')){const box=tr.querySelector('.row-select-box');if(box)box.checked=selectedRows.has(Number(tr.dataset.rowIndex));}const all=container.querySelector('.row-select-all');if(all){const ids=visibleRows(),count=ids.filter(id=>selectedRows.has(id)).length;all.checked=ids.length>0&&count===ids.length;all.indeterminate=count>0&&count<ids.length;}}
  function dropCellIfUnselected(){if(selected&&!selectedRows.has(rowId(selected))){selected.tabIndex=-1;selected=null;key=null;}}
  function toggleRow(id,event){const rows=visibleRows();if(!rows.includes(id))return;if(event?.shiftKey&&anchor!==null&&rows.includes(anchor)){const a=rows.indexOf(anchor),b=rows.indexOf(id);for(const row of rows.slice(Math.min(a,b),Math.max(a,b)+1))selectedRows.add(row);}else{if(selectedRows.has(id))selectedRows.delete(id);else selectedRows.add(id);anchor=id;}dropCellIfUnselected();paint();sync();}
  function selectAllRows(on){const rows=visibleRows();if(on)for(const row of rows)selectedRows.add(row);else for(const row of rows)selectedRows.delete(row);anchor=null;dropCellIfUnselected();paint();sync();}
  function select(cell,focus=false,event=null){if(!cell||!container.contains(cell))return;if(selected?.isConnected)selected.tabIndex=-1;selected=cell;key=identify(cell);const row=rowId(cell),rows=[...container.querySelectorAll('tbody tr')].map(item=>Number(item.dataset.rowIndex));if(!event?.__dbfoxRows){if(event?.shiftKey&&anchor!==null){if(!event.ctrlKey&&!event.metaKey)selectedRows.clear();const a=rows.indexOf(anchor),b=rows.indexOf(row);for(const id of rows.slice(Math.min(a,b),Math.max(a,b)+1))selectedRows.add(id);}else if(event?.ctrlKey||event?.metaKey){if(selectedRows.has(row))selectedRows.delete(row);else selectedRows.add(row);anchor=row;}else{selectedRows.clear();selectedRows.add(row);anchor=row;}if(event)event.__dbfoxRows=true;}if(!selectedRows.size)selectedRows.add(row);paint();sync();if(focus)cell.focus({preventScroll:true});}
  function copyCell(){if(alive())return write(text(selected));notify?.('Selecciona una celda primero.');}
  async function pasteCell(){
    if(pasting||!prepareEdit||!alive())return;
    pasting=true;const target=selected,position=identify(target);
    try{
      const value=await api.readClipboard();
      if(!alive()||selected!==target)throw Error('La celda seleccionada ha cambiado. Vuelve a pegar.');
      const save=await prepareEdit(target),current=alive()?identify(selected):null;
      if(!current||current.row!==position.row||current.column!==position.column)throw Error('La selección ha cambiado. Vuelve a pegar en la celda deseada.');
      save(value);notify?.('Contenido pegado. El cambio queda pendiente de Aplicar cambios.');
    }catch(error){notify?.(error.message);}finally{pasting=false;}
  }
  function copyRows(separator='\t',headers=false){if(!selectedRows.size)return notify?.('Selecciona una o varias filas primero.');const line=values=>values.map(value=>quote(String(value),separator)).join(separator),names=getColumns?.()||[...container.querySelectorAll('thead th')].map(th=>th.textContent.trim());const rows=[...selectedRows].sort((a,b)=>a-b).map(row=>dataCells(container.querySelector(`tr[data-row-index="${row}"]`)).map(cell=>String(text(cell))));return write((headers?[line(names)]:[]).concat(rows.map(line)).join('\r\n'));}
  const editContent=node('button','Editar contenido');editContent.className='secondary';editContent.hidden=!prepareEdit;
  const stageContent=node('button','Dejar cambio pendiente');stageContent.className='primary';stageContent.hidden=true;
  const hint=node('p','');hint.className='designer-help';detail.insertBefore(hint,actions);actions.prepend(editContent,stageContent);
  let detailCell=null,saveContent=null,initialValue='';
  function show(){if(!alive())return;detailCell=selected;saveContent=null;area.readOnly=true;area.value=String(text(selected));initialValue=area.value;editContent.hidden=!prepareEdit;editContent.disabled=false;stageContent.hidden=true;hint.textContent='';if(!detail.open)detail.showModal();area.focus();}
  editContent.onclick=async()=>{
    editContent.disabled=true;
    try{saveContent=await prepareEdit(detailCell);area.readOnly=false;editContent.hidden=true;stageContent.hidden=false;hint.textContent='El cambio quedará pendiente en la tabla. Usa Aplicar cambios para guardarlo en el servidor.';area.focus();}
    catch(error){hint.textContent=error.message;}
    finally{editContent.disabled=false;}
  };
  stageContent.onclick=()=>{
    try{if(area.value!==initialValue)saveContent(area.value);detail.close();}
    catch(error){hint.textContent=error.message;}
  };
  detail.addEventListener('close',()=>{saveContent=null;detailCell=null;});
  copy.onclick=()=>write(area.value);
  const add=(label,action)=>{const item=node('button',typeof label==='function'?label():label);item.type='button';item.setAttribute('role','menuitem');item.onclick=()=>{menu.hidden=true;Promise.resolve(action()).catch(error=>notify?.(error.message));};menu.append(item);};
  const separator=()=>{const line=node('div');line.className='cell-menu-separator';line.setAttribute('role','separator');menu.append(line);};
  add('Copiar celda',copyCell);if(prepareEdit)add('Pegar en celda',pasteCell);add('Ver contenido completo',show);separator();add('Copiar fila(s) seleccionada(s)',()=>copyRows());
  if(onPasteRows){add('Pegar fila(s)',async()=>{let rows=parseClipboardRows(await api.readClipboard());if(!rows.length)throw Error('El portapapeles está vacío.');const headers=getColumns();if(rows.length>1&&rows[0].length===headers.length&&rows[0].every((name,i)=>name===headers[i]))rows=rows.slice(1);if(!rows.length||rows.some(row=>row.length!==headers.length))throw Error('Todas las filas deben tener el mismo número de columnas que el resultado.');await onPasteRows(rows);});
    separator();for(const [name,delimiter] of [['tabulador','\t'],['punto y coma',';'],['coma',',']])add(`Copiar fila(s) con encabezado (${name})`,()=>copyRows(delimiter,true));
    separator();for(const [name,delimiter] of [['tabulador','\t'],['punto y coma',';'],['coma',',']])add(`Copiar fila(s) sin encabezado (${name})`,()=>copyRows(delimiter,false));}
  function context(cell,x,y,event){select(cell,true,selectedRows.has(rowId(cell))?{__dbfoxRows:true}:event);menu.hidden=false;menu.style.left=Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))+'px';menu.querySelector('button').focus();}
  container.addEventListener('click',event=>{if(event.target.closest('input,textarea,.data-fill-handle'))return;const cell=event.target.closest('tbody td');if(cell&&container.contains(cell))select(cell,getSelection()?.isCollapsed!==false,event);});
  container.addEventListener('dblclick',event=>{const cell=event.target.closest('tbody td');if(cell&&container.contains(cell)){select(cell);show();}});
  container.addEventListener('contextmenu',event=>{if(event.target.closest('input,textarea,.data-fill-handle'))return;const cell=event.target.closest('tbody td');if(cell&&container.contains(cell)){event.preventDefault();context(cell,event.clientX,event.clientY,event);}});
  container.addEventListener('keydown',event=>{
    if(event.target.closest('input,textarea,.data-fill-handle'))return;
    const cell=event.target.closest('tbody td');if(!cell||!container.contains(cell))return;if(selected!==cell)select(cell);
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='c'){if(getSelection()?.isCollapsed===false)return;event.preventDefault();event.shiftKey?copyRows():copyCell();return;}
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='v'&&prepareEdit){event.preventDefault();event.stopImmediatePropagation();void pasteCell();return;}
    if(event.key==='F10'&&event.shiftKey){event.preventDefault();const r=cell.getBoundingClientRect();context(cell,r.left,r.bottom,event);return;}
    if(event.key==='Enter'){event.preventDefault();show();return;}
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)||event.shiftKey)return;
    event.preventDefault();const row=cell.parentElement,rows=[...row.parentElement.rows];const rowIndex=rows.indexOf(row),cells=dataCells(row),at=cells.indexOf(cell);let next;
    if(event.key==='ArrowUp'||event.key==='ArrowDown'){const target=rows[rowIndex+(event.key==='ArrowDown'?1:-1)];next=target&&dataCells(target)[at];}
    else next=cells[event.key==='Home'?0:event.key==='End'?cells.length-1:at+(event.key==='ArrowRight'?1:-1)];if(next){select(next,true,event);next.scrollIntoView({block:'nearest',inline:'nearest'});}
  });
  menu.addEventListener('keydown',event=>{const items=[...menu.querySelectorAll('button')];const i=items.indexOf(document.activeElement);if(event.key==='Escape'){event.preventDefault();menu.hidden=true;if(alive())selected.focus();}if(['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();items[(i+(event.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();}});
  document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))menu.hidden=true;});window.addEventListener('resize',()=>{menu.hidden=true;});container.addEventListener('scroll',()=>{menu.hidden=true;});
  const observer=new MutationObserver(()=>{if(alive())return;selected=null;const cells=container.querySelectorAll('tbody td');for(const cell of cells){const id=identify(cell);if(key&&id.row===key.row&&id.column===key.column){select(cell,false,{__dbfoxRows:true});break;}}if(!selected&&cells[0])cells[0].tabIndex=0;paint();sync();});observer.observe(container,{childList:true,subtree:true});
  document.addEventListener('lqtac:sync-copy',sync);if(button)button.onclick=copyCell;sync();
  return {copyCell,select,toggleRow,selectAllRows,position:()=>key||selectedRows.size?{...(key||{}),rows:[...selectedRows]}:null,restore(position){if(!position)return;selectedRows.clear();for(const row of position.rows||[])selectedRows.add(Number(row));const cell=[...container.querySelectorAll('tbody td')].find(td=>{const id=identify(td);return id.row===position.row&&id.column===position.column;});if(cell)select(cell,false,{__dbfoxRows:true});},reset(){selected=null;key=null;anchor=null;selectedRows.clear();menu.hidden=true;for(const item of container.querySelectorAll('.cell-selected,.cell-row-selected'))item.classList.remove('cell-selected','cell-row-selected');paint();sync();}};
}
