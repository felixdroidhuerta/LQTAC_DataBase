(() => {
  const defaults={mode:'light',color:'#078bea',font:'Segoe UI',size:14};
  const fonts=['Segoe UI','Arial','Verdana','Tahoma','Consolas','Courier New'];
  function read(){
    let value={};try{value=JSON.parse(localStorage.getItem('lqtac.appearance')||'{}');}catch{}
    try{if(!value.mode)value.mode=localStorage.getItem('lqtac.theme')==='dark'?'dark':'light';}catch{}
    return {mode:['light','dark','color'].includes(value.mode)?value.mode:defaults.mode,color:/^#[0-9a-f]{6}$/i.test(value.color||'')?value.color:defaults.color,font:typeof value.font==='string'&&value.font.length>0&&value.font.length<=200&&!/[\u0000-\u001f\u007f]/.test(value.font)?value.font:defaults.font,size:Number.isInteger(value.size)&&value.size>=11&&value.size<=20?value.size:defaults.size};
  }
  function apply(value,persist=true){
    const root=document.documentElement;root.dataset.theme=value.mode==='light'?'light':'dark';root.dataset.palette=value.mode;
    root.style.setProperty('--appearance-color',value.color);root.style.setProperty('--appearance-font',`${JSON.stringify(value.font)}, sans-serif`);root.style.setProperty('--appearance-scale',String(value.size/14));
    if(persist)try{localStorage.setItem('lqtac.appearance',JSON.stringify(value));localStorage.setItem('lqtac.theme',value.mode==='light'?'light':'dark');}catch{}
    document.dispatchEvent(new CustomEvent('dbfox:appearance',{detail:value}));
  }
  window.dbfoxAppearance={read,apply,fonts};apply(read(),false);
})();
