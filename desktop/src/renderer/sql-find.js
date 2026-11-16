export function initSQLFind(editor){
  const panel=document.createElement('div');panel.className='sql-find-bar';
  panel.innerHTML='<input id="sql-find-text" aria-label="Buscar en la query" placeholder="Buscar en la query…"><span id="sql-find-count" aria-live="polite"></span><button type="button" data-action="previous" aria-label="Coincidencia anterior">↑</button><button type="button" data-action="next" aria-label="Coincidencia siguiente">↓</button><label><input type="checkbox" id="sql-find-case"> Aa</label><input id="sql-replace-text" aria-label="Reemplazar por" placeholder="Reemplazar por…"><button type="button" data-action="replace">Reemplazar</button><button type="button" data-action="all">Reemplazar todo</button><button type="button" data-action="close" aria-label="Cerrar búsqueda">×</button>';
  panel.querySelector('[data-action="close"]').remove();
  const mode=document.createElement('select');mode.id='sql-find-mode';mode.setAttribute('aria-label','Modo de búsqueda');
  for(const [value,label] of [['find','Buscar'],['replace','Buscar y reemplazar']]){const option=document.createElement('option');option.value=value;option.textContent=label;mode.append(option);}
  panel.prepend(mode);
  document.querySelector('#query-search-section').append(panel);
  const find=panel.querySelector('#sql-find-text'),replacement=panel.querySelector('#sql-replace-text'),matchCase=panel.querySelector('#sql-find-case'),count=panel.querySelector('#sql-find-count');
  let matches=[];
  function refresh(){
    const source=editor.value,term=find.value;matches=[];
    if(term){
      // Escape the pattern so replacement always treats the search as literal text.
      const pattern=new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),matchCase.checked?'g':'gi');
      for(const match of source.matchAll(pattern))matches.push({start:match.index,end:match.index+match[0].length});
    }
    const selected=matches.findIndex(match=>match.start===editor.selectionStart&&match.end===editor.selectionEnd);
    count.textContent=matches.length?`${selected<0?'—':selected+1} de ${matches.length}`:'0 coincidencias';
    for(const button of panel.querySelectorAll('[data-action="previous"],[data-action="next"],[data-action="replace"],[data-action="all"]'))button.disabled=!matches.length;
  }
  function select(match){
    if(!match)return;
    editor.focus();editor.setSelectionRange(match.start,match.end);
    const line=editor.value.slice(0,match.start).split('\n').length-1;
    const style=getComputedStyle(editor),height=parseFloat(style.lineHeight)||20;
    editor.scrollTop=Math.max(0,line*height-editor.clientHeight/2);
    editor.dispatchEvent(new Event('scroll'));refresh();
  }
  function navigate(backwards=false){
    refresh();if(!matches.length)return;
    const match=backwards?[...matches].reverse().find(item=>item.end<=editor.selectionStart):matches.find(item=>item.start>=editor.selectionEnd);
    select(match||(backwards?matches.at(-1):matches[0]));
  }
  function insert(start,end,value){
    editor.focus();editor.setSelectionRange(start,end);
    if(!document.execCommand('insertText',false,value)){
      editor.setRangeText(value,start,end,'end');editor.dispatchEvent(new Event('input',{bubbles:true}));
    }
    refresh();
  }
  function replace(all){
    refresh();if(!matches.length)return;
    if(all){
      const source=editor.value;let start=0,value='';
      for(const match of matches){value+=source.slice(start,match.start)+replacement.value;start=match.end;}
      insert(0,source.length,value+source.slice(start));
    }else{
      const selected=matches.find(item=>item.start===editor.selectionStart&&item.end===editor.selectionEnd);
      if(!selected){navigate();return;}
      insert(selected.start,selected.end,replacement.value);navigate();
    }
  }
  function setMode(withReplace){
    mode.value=withReplace?'replace':'find';replacement.hidden=!withReplace;
    for(const button of panel.querySelectorAll('[data-action="replace"],[data-action="all"]'))button.hidden=!withReplace;
  }
  mode.onchange=()=>{setMode(mode.value==='replace');refresh();};
  function open(withReplace=false){
    const selected=editor.value.slice(editor.selectionStart,editor.selectionEnd);
    setMode(withReplace);
    if(selected&&!selected.includes('\n'))find.value=selected;
    refresh();find.focus();find.select();
  }
  panel.onclick=event=>{
    const action=event.target.closest('[data-action]')?.dataset.action;
    if(action==='previous'||action==='next')navigate(action==='previous');
    if(action==='replace'||action==='all')replace(action==='all');
  };
  find.oninput=refresh;matchCase.onchange=refresh;
  editor.addEventListener('input',()=>{if(!panel.hidden)refresh();});
  editor.addEventListener('select',()=>{if(!panel.hidden)refresh();});
  document.addEventListener('keydown',event=>{
    if(document.querySelector('dialog[open]')||document.querySelector('#sql').classList.contains('hidden'))return;
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&['f','h'].includes(event.key.toLowerCase())){event.preventDefault();open(event.key.toLowerCase()==='h');}
    else if(event.key==='Escape'&&panel.contains(event.target)){event.preventDefault();editor.focus();}
    else if(panel.contains(event.target)&&event.key==='Enter'){event.preventDefault();navigate(event.shiftKey);}
  });
  const button=document.createElement('button');button.id='open-sql-find';button.type='button';button.className='mini-tool';button.textContent='⌕';button.setAttribute('aria-label','Buscar y reemplazar en la query');button.dataset.hint='Buscar y reemplazar en la query · Ctrl+F buscar · Ctrl+H reemplazar';button.onclick=()=>open(true);
  document.querySelector('.editor-caption .mini-tools').append(button);
  setMode(false);refresh();
}
