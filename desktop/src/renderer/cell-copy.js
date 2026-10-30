const node=(tag,text)=>{const item=document.createElement(tag);if(text!==undefined)item.textContent=text;return item;};
const text=cell=>cell.copyValue??cell.textContent;
const tsv=value=>/[\t\r\n"]/.test(value)?'"'+value.replaceAll('"','""')+'"':value;
export function attachCellCopy(container,{api,notify,button}={}){
  if(button)button.dataset.localAction='true';
  let selected=null,key=null;const menu=node('div');menu.className='cell-copy-menu';menu.hidden=true;menu.setAttribute('role','menu');
  const detail=node('dialog');detail.className='cell-detail-dialog';const heading=node('h2','Contenido de la celda');const area=node('textarea');area.readOnly=true;area.wrap='off';area.setAttribute('aria-label','Contenido completo de la celda');const actions=node('div');const copy=node('button','Copiar contenido');copy.className='primary';const close=node('button','Cerrar');close.className='secondary';close.onclick=()=>detail.close();actions.append(close,copy);detail.append(heading,area,actions);document.body.append(menu,detail);
  const alive=()=>selected?.isConnected&&container.contains(selected);
  function sync(){if(button)button.disabled=!alive();}
  async function write(value){try{await api.writeClipboard(String(value));notify?.('Contenido copiado.');}catch(error){notify?.(error.message);}}
  function identify(cell){const row=cell.parentElement;return {row:row.dataset.copyRow??row.dataset.rowIndex,column:cell.cellIndex};}
  function select(cell,focus=false){if(!cell||!container.contains(cell))return;for(const item of container.querySelectorAll('.cell-selected,.cell-row-selected'))item.classList.remove('cell-selected','cell-row-selected');if(selected?.isConnected)selected.tabIndex=-1;selected=cell;key=identify(cell);cell.classList.add('cell-selected');cell.parentElement.classList.add('cell-row-selected');cell.tabIndex=0;sync();if(focus)cell.focus({preventScroll:true});}
  function copyCell(){if(alive())return write(text(selected));notify?.('Selecciona una celda primero.');}
  function copyRow(){if(alive())return write([...selected.parentElement.cells].map(cell=>tsv(String(text(cell)))).join('\t'));}
  function show(){if(!alive())return;area.value=String(text(selected));if(!detail.open)detail.showModal();area.focus();}
  copy.onclick=()=>write(area.value);
  for(const [label,action] of [['Copiar celda',copyCell],['Copiar fila',copyRow],['Ver contenido completo',show]]){const item=node('button',label);item.type='button';item.setAttribute('role','menuitem');item.onclick=()=>{menu.hidden=true;action();};menu.append(item);}
  function context(cell,x,y){select(cell,true);menu.hidden=false;menu.style.left=Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))+'px';menu.querySelector('button').focus();}
  container.addEventListener('click',event=>{const cell=event.target.closest('tbody td');if(cell&&container.contains(cell))select(cell,getSelection()?.isCollapsed!==false);});
  container.addEventListener('dblclick',event=>{const cell=event.target.closest('tbody td');if(cell&&container.contains(cell)){select(cell);show();}});
  container.addEventListener('contextmenu',event=>{if(event.target.closest('input,textarea,.data-fill-handle'))return;const cell=event.target.closest('tbody td');if(cell&&container.contains(cell)){event.preventDefault();context(cell,event.clientX,event.clientY);}});
  container.addEventListener('keydown',event=>{
    if(event.target.closest('input,textarea,.data-fill-handle'))return;
    const cell=event.target.closest('tbody td');if(!cell||!container.contains(cell))return;if(selected!==cell)select(cell);
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='c'){if(getSelection()?.isCollapsed===false)return;event.preventDefault();event.shiftKey?copyRow():copyCell();return;}
    if(event.key==='F10'&&event.shiftKey){event.preventDefault();const r=cell.getBoundingClientRect();context(cell,r.left,r.bottom);return;}
    if(event.key==='Enter'){event.preventDefault();show();return;}
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)||event.shiftKey)return;
    event.preventDefault();const row=cell.parentElement,rows=[...row.parentElement.rows];const rowIndex=rows.indexOf(row);let next;
    if(event.key==='ArrowUp'||event.key==='ArrowDown')next=rows[rowIndex+(event.key==='ArrowDown'?1:-1)]?.cells[cell.cellIndex];
    else next=row.cells[event.key==='Home'?0:event.key==='End'?row.cells.length-1:cell.cellIndex+(event.key==='ArrowRight'?1:-1)];if(next){select(next,true);next.scrollIntoView({block:'nearest',inline:'nearest'});}
  });
  menu.addEventListener('keydown',event=>{const items=[...menu.querySelectorAll('button')];const i=items.indexOf(document.activeElement);if(event.key==='Escape'){event.preventDefault();menu.hidden=true;if(alive())selected.focus();}if(['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();items[(i+(event.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();}});
  document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))menu.hidden=true;});window.addEventListener('resize',()=>{menu.hidden=true;});container.addEventListener('scroll',()=>{menu.hidden=true;});
  const observer=new MutationObserver(()=>{if(alive())return;selected=null;const cells=container.querySelectorAll('tbody td');for(const cell of cells){const id=identify(cell);if(key&&id.row===key.row&&id.column===key.column){select(cell);break;}}if(!selected&&cells[0])cells[0].tabIndex=0;sync();});observer.observe(container,{childList:true,subtree:true});
  document.addEventListener('lqtac:sync-copy',sync);if(button)button.onclick=copyCell;sync();
  return {copyCell,select,position:()=>key?{...key}:null,restore(position){if(!position)return;const cell=[...container.querySelectorAll('tbody td')].find(td=>{const id=identify(td);return id.row===position.row&&id.column===position.column;});if(cell)select(cell);},reset(){selected=null;key=null;menu.hidden=true;for(const item of container.querySelectorAll('.cell-selected,.cell-row-selected'))item.classList.remove('cell-selected','cell-row-selected');sync();}};
}
