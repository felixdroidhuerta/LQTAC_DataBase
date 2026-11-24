export function attachColumnResize(table,widths){
 const headers=[...table.querySelectorAll('thead th')],offset=headers[0]?.classList.contains('row-select-head')?1:0;
 const group=document.createElement('colgroup'),cols=[];
 const clamp=value=>Math.max(48,Math.min(5000,Math.round(value)));
 const sample=[...table.tBodies[0]?.rows||[]].slice(0,10);
 const natural=headers.map((th,i)=>th.offsetWidth||(i<offset?34:Math.max(80,Math.min(384,Math.max(th.textContent.length,...sample.map(row=>row.cells[i]?.textContent.length||0))*7+24))));
 const sizes=headers.map((th,i)=>i<offset?natural[i]:clamp(Number.isFinite(widths[i-offset])?widths[i-offset]:natural[i]));
 sizes.forEach((size,i)=>{const col=document.createElement('col');col.style.width=size+'px';group.append(col);cols.push(col);if(i>=offset)widths[i-offset]=size;});
 table.prepend(group);table.classList.add('resizable-results');let drag=null;
 function set(i,value){sizes[i]=clamp(value);widths[i-offset]=sizes[i];cols[i].style.width=sizes[i]+'px';table.style.width=sizes.reduce((a,b)=>a+b,0)+'px';const handle=headers[i].querySelector('.result-column-resizer');handle?.setAttribute('aria-valuenow',String(sizes[i]));}
 table.style.width=sizes.reduce((a,b)=>a+b,0)+'px';
 function finish(){if(!drag)return;const previous=drag;drag=null;document.body.classList.remove('resizing-result-column');try{previous.handle.releasePointerCapture(previous.pointer);}catch{}}
 headers.forEach((th,i)=>{
  if(i<offset)return;
  const handle=document.createElement('span');handle.className='result-column-resizer';handle.tabIndex=0;handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label','Ajustar ancho de '+th.textContent);handle.setAttribute('aria-valuemin','48');handle.setAttribute('aria-valuemax','5000');handle.setAttribute('aria-valuenow',String(sizes[i]));
  handle.title='Arrastra para ajustar el ancho. Doble clic para restablecer.';th.append(handle);
  handle.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();finish();const scale=table.getBoundingClientRect().width/table.offsetWidth||1;drag={handle,pointer:event.pointerId,x:event.clientX,width:sizes[i],scale};handle.setPointerCapture(event.pointerId);document.body.classList.add('resizing-result-column');};
  handle.onpointermove=event=>{if(drag?.handle===handle&&drag.pointer===event.pointerId)set(i,drag.width+(event.clientX-drag.x)/drag.scale);};
  handle.onpointerup=handle.onpointercancel=handle.onlostpointercapture=finish;
  handle.onclick=event=>event.stopPropagation();handle.ondblclick=event=>{event.preventDefault();event.stopPropagation();set(i,natural[i]);};
  handle.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home'].includes(event.key)){event.preventDefault();event.stopPropagation();set(i,event.key==='Home'?natural[i]:sizes[i]+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?50:10));}};
 });
 return finish;
}
