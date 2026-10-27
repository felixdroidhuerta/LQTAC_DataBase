try { document.documentElement.dataset.theme=localStorage.getItem('lqtac.theme')==='dark'?'dark':'light'; } catch { document.documentElement.dataset.theme='light'; }
