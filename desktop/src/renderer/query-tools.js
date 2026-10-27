const $=selector=>document.querySelector(selector);
const node=(tag,text)=>{const value=document.createElement(tag);if(text!==undefined)value.textContent=text;return value;};
export function initQueryTools({api,getConnection,runSelection,runTask,notify,isBusy,getExportRows,hasPendingEdits}) {
  let snapshot=null; const editor=$('#query'); const index=$('#export-result-index');
  try{const limit=Number(localStorage.getItem('lqtac.resultLimit') ?? 1000);if([0,50,100,500,1000].includes(limit))$('#result-limit').value=String(limit);}catch{}
  $('#result-limit').onchange=()=>{try{localStorage.setItem('lqtac.resultLimit',$('#result-limit').value);}catch{}};
  const theme=()=>$('#toggle-theme').setAttribute('aria-pressed',String(document.documentElement.dataset.theme==='dark'));theme();
  $('#toggle-theme').onclick=()=>{const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{localStorage.setItem('lqtac.theme',next);}catch{}theme();};
  $('#run-selection').onclick=()=>runSelection();
  document.addEventListener('keydown',event=>{if(event.altKey&&event.shiftKey&&event.key.toLowerCase()==='f'&&!$('#sql').classList.contains('hidden')){event.preventDefault();if(!isBusy())$('#format-query').click();}});
  $('#format-query').onclick=()=>runTask(async()=>{
    const source=editor.value,start=editor.selectionStart,end=editor.selectionEnd;const selected=end>start;const formatted=await api.formatQuery(selected?source.slice(start,end):source,getConnection()?.engine||'sqlite');
    if(editor.value!==source)return notify('La consulta ha cambiado durante el formato. Vuelve a intentarlo.');
    editor.focus();editor.setSelectionRange(selected?start:0,selected?end:source.length);
    // Native insertText keeps the formatting action in the editor undo history.
    if(!document.execCommand('insertText',false,formatted)){editor.setRangeText(formatted,selected?start:0,selected?end:source.length,'end');editor.dispatchEvent(new Event('input',{bubbles:true}));}
  });
  function syncButtons(){for(const id of ['#export-csv','#export-xlsx'])$(id).disabled=isBusy()||hasPendingEdits?.()||index.value===''||!snapshot?.results?.[Number(index.value)]?.columns?.length;}
  document.addEventListener('lqtac:data-changed',syncButtons);
  index.addEventListener('change',syncButtons);
  for(const format of ['csv','xlsx'])$('#export-'+format).onclick=()=>runTask(async()=>{if(snapshot&&await api.exportResult(snapshot.exportToken,Number(index.value||0),format,getExportRows?.()))notify('Resultado exportado.');});
  const tooltip=node('div');tooltip.className='tool-tip hidden';tooltip.id='query-tool-tip';tooltip.setAttribute('role','tooltip');document.body.append(tooltip);
  let target;
  const hide=()=>{tooltip.classList.add('hidden');if(target)target.removeAttribute('aria-describedby');target=null;};
  function tip(event){const button=event.target.closest('[data-hint]');if(!button)return;target=button;tooltip.textContent=button.dataset.hint;tooltip.classList.remove('hidden');button.setAttribute('aria-describedby',tooltip.id);const r=button.getBoundingClientRect();tooltip.style.left=Math.max(8,Math.min(r.left,innerWidth-tooltip.offsetWidth-8))+'px';tooltip.style.top=Math.max(8,Math.min(r.bottom+7,innerHeight-tooltip.offsetHeight-8))+'px';}
  document.addEventListener('pointerover',tip);document.addEventListener('focusin',tip);document.addEventListener('pointerout',event=>{if(target&&!target.contains(event.relatedTarget))hide();});document.addEventListener('focusout',hide);window.addEventListener('resize',hide);document.addEventListener('scroll',hide,true);
  const dialog=node('dialog');dialog.id='relations-dialog';const heading=node('h2','Relaciones entre tablas');const controls=node('div');controls.className='relations-controls';const schema=node('select');schema.setAttribute('aria-label','Base o esquema del diagrama');const search=node('input');search.placeholder='Filtrar tabla y sus relaciones…';search.setAttribute('aria-label','Filtrar tablas del diagrama');const zoom=node('select');zoom.setAttribute('aria-label','Zoom del diagrama');for(const value of [50,75,100,125,150]){const option=node('option',value+'%');option.value=value;zoom.append(option);}zoom.value='100';const close=node('button','Cerrar');close.className='secondary';close.onclick=()=>dialog.close();controls.append(schema,search,zoom,close);const message=node('p');message.id='relations-message';const scroll=node('div');scroll.className='relations-scroll';const canvas=node('div');canvas.className='relations-canvas';scroll.append(canvas);dialog.append(heading,controls,message,scroll);document.body.append(dialog);
  let graph=null,session=null;
  const svgNode=tag=>document.createElementNS('http://www.w3.org/2000/svg',tag);
  function draw(){
    canvas.replaceChildren();if(!graph)return;const term=search.value.toLocaleLowerCase();const selected=new Set(graph.nodes.filter(item=>`${item.schema}.${item.name}`.toLocaleLowerCase().includes(term)).map(item=>item.id));
    if(term)for(const edge of graph.edges)if(selected.has(edge.from)||selected.has(edge.to)){selected.add(edge.from);selected.add(edge.to);}
    const nodes=graph.nodes.filter(item=>selected.has(item.id)).slice(0,80);const positions=new Map(nodes.map((item,i)=>[item.id,{x:30+(i%3)*340,y:30+Math.floor(i/3)*165}]));
    canvas.style.width='1040px';canvas.style.height=Math.max(180,Math.ceil(nodes.length/3)*165+30)+'px';canvas.style.zoom=Number(zoom.value)/100;
    const svg=svgNode('svg');svg.setAttribute('width','1040');svg.setAttribute('height',canvas.style.height);const defs=svgNode('defs'),marker=svgNode('marker');marker.id='relation-arrow';marker.setAttribute('viewBox','0 0 10 10');marker.setAttribute('refX','9');marker.setAttribute('refY','5');marker.setAttribute('markerWidth','7');marker.setAttribute('markerHeight','7');marker.setAttribute('orient','auto-start-reverse');const arrow=svgNode('path');arrow.setAttribute('d','M 0 0 L 10 5 L 0 10 z');arrow.setAttribute('fill','#208bbd');marker.append(arrow);defs.append(marker);svg.append(defs);
    for(const edge of graph.edges){const a=positions.get(edge.from),b=positions.get(edge.to);if(!a||!b)continue;const line=svgNode('path');line.setAttribute('d',`M ${a.x+240} ${a.y+50} C ${a.x+300} ${a.y+50}, ${b.x-60} ${b.y+50}, ${b.x} ${b.y+50}`);line.setAttribute('fill','none');line.setAttribute('stroke','#208bbd');line.setAttribute('stroke-width','2');line.setAttribute('marker-end','url(#relation-arrow)');const title=svgNode('title');title.textContent=edge.name+': '+edge.columns.map(item=>item.from+' → '+item.to).join(', ');line.append(title);svg.append(line);}canvas.append(svg);
    for(const item of nodes){const card=node('article');card.className='relation-card';const pos=positions.get(item.id);card.style.left=pos.x+'px';card.style.top=pos.y+'px';card.append(node('strong',item.name),node('small',item.schema));const keys=graph.edges.filter(edge=>edge.from===item.id).flatMap(edge=>edge.columns.map(key=>key.from+' → '+JSON.parse(edge.to)[1]+'.'+key.to));card.append(node('p',keys.join('\n')||'Sin claves foráneas salientes'));canvas.append(card);}
    message.textContent=`${nodes.length} de ${graph.nodes.length} tablas · ${graph.edges.length} relaciones declaradas.${selected.size>80?' Filtra para ver otras tablas.':''} ${graph.warning||(!graph.edges.length?'No hay claves foráneas visibles para este usuario.':'')}`;
  }
  async function load(){graph=null;canvas.replaceChildren();message.textContent='Leyendo relaciones…';const key=session;const name=schema.value;try{const result=await api.relations(name,key);if(session===key&&schema.value===name){graph=result;draw();}}catch(error){message.textContent=error.message;}}
  schema.onchange=()=>{search.value='';load();};search.oninput=draw;zoom.onchange=draw;
  $('#show-relations').onclick=()=>{if(isBusy())return;const connection=getConnection();if(!connection)return notify('Conecta con una base primero.');session=connection.sessionKey;schema.replaceChildren();for(const item of connection.schemas||[]){const option=node('option',item.name);option.value=item.name;schema.append(option);}schema.value=connection.database||schema.options[0]?.value||'';heading.textContent='Relaciones · '+connection.name;if(!dialog.open)dialog.showModal();load();};
  return {syncButtons,clearResults(){snapshot=null;index.replaceChildren();index.hidden=true;syncButtons();},updateResults(output){snapshot=output;index.replaceChildren();output.results.forEach((result,i)=>{const option=node('option',`${result.label||'Resultado '+(i+1)} (${result.values.length})`);option.value=i;index.append(option);});index.hidden=output.results.length<2;syncButtons();}};
}
