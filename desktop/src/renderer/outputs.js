import {attachCellCopy} from './cell-copy.js';
const storageKey = 'lqtac.outputsLayout';
const docks = ['bottom', 'top', 'left', 'right', 'floating'];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };

export function initOutputs({api,notify}) {
  const sql = document.querySelector('#sql'); const stage = document.querySelector('#sql-stage');
  const workspace = document.querySelector('#query-workspace'); const note = document.querySelector('#execution-note');
  const state = { dock: 'bottom', expanded: false, height:180, width:320, x:160, y:160, floatWidth:680, floatHeight:240 };
  try { const saved = JSON.parse(localStorage.getItem(storageKey)); if (docks.includes(saved?.dock)) state.dock = saved.dock; if (typeof saved?.expanded === 'boolean') state.expanded = saved.expanded; for (const key of ['height','width','x','y','floatWidth','floatHeight']) if (Number.isFinite(saved?.[key])) state[key] = saved[key]; } catch { /* Defaults when no preferences exist. */ }
  const panel = node('section', undefined, 'outputs-panel'); panel.id = 'outputs-panel'; panel.setAttribute('aria-label', 'Salidas de ejecución');
  const header = node('header', undefined, 'outputs-title'); header.title = 'Arrastra para mover o acoplar el panel. Escape cancela el arrastre.';
  const toggle = node('button'); toggle.id = 'outputs-toggle'; toggle.setAttribute('aria-controls', 'outputs-body');
  toggle.dataset.localAction='true';
  const title = node('strong', 'Salidas / Output'); const count = node('span', '0', 'outputs-count');
  const location = node('select'); location.id = 'outputs-location'; location.setAttribute('aria-label', 'Posición del panel de salidas');
  docks.forEach((dock, index) => { const option = node('option', ['Abajo','Arriba','Izquierda','Derecha','Flotante'][index]); option.value = dock; location.append(option); });
  const clear = node('button', 'Limpiar'); clear.id = 'outputs-clear'; clear.title = 'Vaciar el historial de esta sesión';
  header.append(toggle, title, count, location, clear);
  const copy=node('button','⧉');copy.id='copy-output-cell';copy.setAttribute('aria-label','Copiar celda de salida');copy.title='Copiar la celda seleccionada (Ctrl+C)';header.insertBefore(copy,clear);
  const body = node('div', undefined, 'outputs-body'); body.id = 'outputs-body';
  const table = node('table', undefined, 'outputs-grid'); const head = node('thead'); const columns = node('tr');
  ['Estado','Hora','Conexión','Acción','Mensaje','Duración'].forEach(label => columns.append(node('th', label))); head.append(columns);
  const rows = node('tbody'); table.append(head, rows);
  const empty = node('p', 'Las ejecuciones aparecerán aquí. Se conservan las últimas 200 durante esta sesión.', 'outputs-empty'); body.append(empty, table);
  const resize = node('div', undefined, 'outputs-resize'); resize.tabIndex = 0; resize.setAttribute('role','separator'); resize.setAttribute('aria-label','Redimensionar panel de salidas');
  panel.append(header, body, resize);
  const selection=attachCellCopy(body,{api,notify,button:copy});
  const hint = node('div', undefined, 'outputs-drop hidden'); document.body.append(hint);
  let entries = []; let sequence = 0; let drag = null;
  const save = () => { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Session preferences still apply. */ } };
  function apply() {
    const side = ['left','right'].includes(state.dock);
    const place = (parent, before) => { if(panel.parentNode!==parent || panel.nextSibling!==before) parent.insertBefore(panel,before); };
    if (side) place(stage,state.dock==='left'?workspace:null);
    else place(sql,state.dock==='top'?stage:note);
    panel.dataset.dock = state.dock; panel.classList.toggle('collapsed', !state.expanded);
    body.hidden = !state.expanded; toggle.textContent = state.expanded ? '▾' : '▸'; toggle.setAttribute('aria-expanded', String(state.expanded)); toggle.setAttribute('aria-label', state.expanded ? 'Colapsar salidas' : 'Expandir salidas'); location.value = state.dock;
    panel.style.setProperty('--outputs-height', `${clamp(state.height,100,Math.max(100,sql.clientHeight*.45))}px`);
    panel.style.setProperty('--outputs-width', `${clamp(state.width,220,Math.max(220,stage.clientWidth*.45))}px`);
    const floating = state.dock === 'floating';
    state.floatWidth = clamp(state.floatWidth,320,Math.max(320,innerWidth-16)); state.floatHeight = clamp(state.floatHeight,120,Math.max(120,innerHeight-16));
    state.x = clamp(state.x,8,Math.max(8,innerWidth-state.floatWidth-8)); state.y = clamp(state.y,8,Math.max(8,innerHeight-(state.expanded ? state.floatHeight : 34)-8));
    for (const [property,value] of Object.entries({ left:state.x, top:state.y, width:state.floatWidth, height:state.floatHeight })) panel.style[property] = floating ? `${value}px` : '';
    resize.setAttribute('aria-orientation', side ? 'vertical' : 'horizontal');
  }
  function render() {
    rows.replaceChildren(); empty.hidden = !!entries.length; table.hidden = !entries.length; count.textContent = String(entries.length);
    for (const entry of entries) {
      const row = node('tr'); row.dataset.status = entry.status;row.dataset.copyRow=String(entry.id);
      const status = node('td', { running:'◷',success:'✓',error:'✕',warning:'⚠' }[entry.status], `output-${entry.status}`); status.title = { running:'En ejecución',success:'Correcto',error:'Error',warning:'Aviso' }[entry.status];
      status.copyValue=status.title;row.append(status);
      for (const text of [entry.time, entry.connection, entry.sql, entry.message, entry.duration == null ? '…' : `${entry.duration} ms`]) { const cell = node('td', text.length>2000?text.slice(0,2000)+'…':text);cell.copyValue=text;cell.title=text.slice(0,1000);row.append(cell); }
      row.title = `${entry.tab}\n${entry.sql.slice(0,1000)}\n${entry.message.slice(0,1000)}`; rows.append(row);
    }
    body.scrollTop = body.scrollHeight;
  }
  toggle.onclick = () => { state.expanded = !state.expanded; apply(); save(); };
  location.onchange = () => { state.dock = location.value; apply(); save(); };
  clear.onclick = () => { selection.reset();entries = []; render(); };
  function candidate(x,y) {
    const rect = stage.getBoundingClientRect(); if (x<rect.left-30 || x>rect.right+30 || y<rect.top-30 || y>rect.bottom+30) return null;
    const near = [['left',Math.abs(x-rect.left)],['right',Math.abs(x-rect.right)],['top',Math.abs(y-rect.top)],['bottom',Math.abs(y-rect.bottom)]].sort((a,b)=>a[1]-b[1])[0]; return near[1]<70 ? near[0] : null;
  }
  function showHint(dock) {
    hint.classList.toggle('hidden', !dock); if (!dock) return;
    const rect = stage.getBoundingClientRect(); const side = ['left','right'].includes(dock); const width = side ? Math.min(320,rect.width*.4) : rect.width; const height = side ? rect.height : Math.min(180,rect.height*.4);
    Object.assign(hint.style,{ left:`${dock==='right' ? rect.right-width : rect.left}px`,top:`${dock==='bottom' ? rect.bottom-height : rect.top}px`,width:`${width}px`,height:`${height}px` }); hint.textContent = `Acoplar ${ {left:'a la izquierda',right:'a la derecha',top:'arriba',bottom:'abajo'}[dock] }`;
  }
  function begin(event, kind) {
    if (event.button!==0 || drag || (kind==='move' && event.target.closest('button,select'))) return;
    event.preventDefault(); const rect = panel.getBoundingClientRect();
    drag = { kind, pointer:event.pointerId, handle:event.currentTarget, x:event.clientX, y:event.clientY, dx:Math.min(event.clientX-rect.left,state.floatWidth-40), dy:event.clientY-rect.top, state:{...state}, moved:false, dock:null };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  header.addEventListener('pointerdown', event => begin(event,'move')); resize.addEventListener('pointerdown', event => begin(event,'resize'));
  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId!==drag.pointer) return;
    const dx=event.clientX-drag.x, dy=event.clientY-drag.y; if (!drag.moved && Math.hypot(dx,dy)<4) return;
    drag.moved=true; document.body.classList.add('moving-output');
    if (drag.kind==='move') { state.dock='floating'; state.x=event.clientX-drag.dx; state.y=event.clientY-drag.dy; apply(); drag.handle.setPointerCapture(drag.pointer); drag.dock=candidate(event.clientX,event.clientY); showHint(drag.dock); }
    else { const dock=drag.state.dock; if(dock==='floating') { state.floatWidth=drag.state.floatWidth+dx; state.floatHeight=drag.state.floatHeight+dy; } else if(['left','right'].includes(dock)) state.width=drag.state.width+dx*(dock==='left'?1:-1); else state.height=drag.state.height+dy*(dock==='top'?1:-1); apply(); }
  });
  function finish(cancel=false) {
    if(!drag) return; const previous=drag; drag=null;
    if(cancel) Object.assign(state,previous.state); else if(previous.kind==='move' && previous.moved && previous.dock) state.dock=previous.dock;
    hint.classList.add('hidden'); document.body.classList.remove('moving-output'); if(previous.handle.hasPointerCapture(previous.pointer)) previous.handle.releasePointerCapture(previous.pointer); apply(); save();
  }
  window.addEventListener('pointerup', event=>{if(drag?.pointer===event.pointerId) finish();}); window.addEventListener('pointercancel',()=>finish(true)); window.addEventListener('blur',()=>finish(true));
  const lost = () => { if(drag && !drag.handle.hasPointerCapture(drag.pointer)) finish(true); };
  header.addEventListener('lostpointercapture',lost); resize.addEventListener('lostpointercapture',lost);
  window.addEventListener('keydown',event=>{if(event.key==='Escape' && drag){event.preventDefault();finish(true);}});
  resize.addEventListener('keydown',event=>{if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home'].includes(event.key))return;event.preventDefault();const amount=(event.key==='ArrowUp'||event.key==='ArrowLeft'?-1:1)*(event.shiftKey?40:10);if(state.dock==='floating'){if(event.key.includes('Left')||event.key.includes('Right'))state.floatWidth+=amount;else state.floatHeight+=amount;}else if(['left','right'].includes(state.dock))state.width+=amount;else state.height+=amount;if(event.key==='Home'){state.height=180;state.width=320;state.floatWidth=680;state.floatHeight=240;}apply();save();});
  window.addEventListener('resize',apply);
  // Fixed floating panels still belong to SQL; hidden ancestors prevent them leaking into other views.
  const visibility = new MutationObserver(apply); visibility.observe(sql,{attributes:true,attributeFilter:['class']});
  apply(); render();
  return {
    start({sql,connection,tab,time}) { const entry={ id:++sequence, time:time?new Date(time).toLocaleTimeString('es-ES'):new Date().toLocaleTimeString('es-ES'), sql, connection, tab, message:'Ejecutando…',status:'running',duration:null }; entries.push(entry); entries=entries.slice(-200);while(entries.length>1&&entries.reduce((sum,item)=>sum+item.sql.length+item.message.length,0)>8000000)entries.shift();render();return entry.id; },
    finish(id,{message,duration,status}) { const entry=entries.find(item=>item.id===id);if(entry){Object.assign(entry,{message:String(message),duration,status});render();} }
  };
}
