export function initLineNumbers(editor){
  const surface=editor.closest('.query-editor'),gutter=document.createElement('div');gutter.className='sql-line-gutter';gutter.setAttribute('aria-hidden','true');surface.append(gutter);
  const button=document.createElement('button');button.id='toggle-line-numbers';button.type='button';button.className='mini-tool';button.textContent='☷ 1';button.setAttribute('aria-label','Mostrar números de línea');button.dataset.hint='Mostrar u ocultar números de línea';document.querySelector('.editor-caption .mini-tools').append(button);
  let enabled=false,count=1;try{enabled=localStorage.getItem('lqtac.lineNumbers')==='true';}catch{}
  function recount(){count=1;for(let i=0;i<editor.value.length;i++)if(editor.value.charCodeAt(i)===10)count++;draw();}
  function draw(){if(!enabled)return;const style=getComputedStyle(editor),lineHeight=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.5,padding=parseFloat(style.paddingTop)||0,scroll=editor.scrollTop;
    const first=Math.max(0,Math.floor((scroll-padding)/lineHeight)),last=Math.min(count,Math.ceil((scroll+editor.clientHeight-padding)/lineHeight)+1);const fragment=document.createDocumentFragment();
    for(let i=first;i<last;i++){const item=document.createElement('div');item.textContent=String(i+1);item.style.top=`${padding+i*lineHeight-scroll}px`;item.style.height=`${lineHeight}px`;item.style.lineHeight=`${lineHeight}px`;fragment.append(item);}gutter.replaceChildren(fragment);gutter.style.fontFamily=style.fontFamily;gutter.style.fontSize=style.fontSize;
  }
  function apply(){surface.classList.toggle('with-line-numbers',enabled);gutter.hidden=!enabled;button.setAttribute('aria-pressed',String(enabled));try{localStorage.setItem('lqtac.lineNumbers',String(enabled));}catch{}recount();}
  button.onclick=()=>{enabled=!enabled;apply();};editor.addEventListener('input',recount);editor.addEventListener('scroll',draw);editor.addEventListener('sql-highlight:refresh',recount);window.addEventListener('resize',draw);new ResizeObserver(draw).observe(editor);document.addEventListener('dbfox:appearance',()=>requestAnimationFrame(draw));apply();
}
