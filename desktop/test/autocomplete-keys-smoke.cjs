const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {startMySQLFixture}=require('./mysql-fixture.cjs');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'dbfox-completion-keys-')));
app.on('browser-window-created',(_e,w)=>{w.hide();w.webContents.setBackgroundThrottling(false);});
require('../src/main.cjs');
const timeout=setTimeout(()=>{console.error('Completion keys timed out');app.exit(1);},35000);
app.whenReady().then(async()=>{
 const w=BrowserWindow.getAllWindows()[0],fixture=await startMySQLFixture(),js=code=>w.webContents.executeJavaScript(code);
 const until=expression=>js(`new Promise((resolve,reject)=>{const start=Date.now();function poll(){if(${expression})return resolve();if(Date.now()-start>10000)return reject(Error('Timeout'));setTimeout(poll,40)}poll()})`);
 const type=async(sql,cursor=sql.length)=>js(`(()=>{const e=document.querySelector('#query');e.focus();e.value=${JSON.stringify(sql)};e.setSelectionRange(${cursor},${cursor});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const key=async keyCode=>{w.webContents.sendInputEvent({type:'keyDown',keyCode});w.webContents.sendInputEvent({type:'keyUp',keyCode});await js('new Promise(r=>setTimeout(r,80))');};
 try{
  if(w.webContents.isLoading())await new Promise(r=>w.webContents.once('did-finish-load',r));
  await js(`window.lqtac.saveConnection(${JSON.stringify(fixture.profile)})`);
  await js(`document.querySelector('[data-view=connections]').click()`);
  await until(`document.querySelector('.profile-row .primary')`);
  await js(`document.querySelector('.profile-row .primary').click()`);await until(`document.querySelector('#credentials-dialog').open`);
  await js(`document.querySelector('#connection-password').value='fixture-test-password';document.querySelector('#credentials-form').requestSubmit()`);
  await until(`!document.querySelector('#credentials-dialog').open && !document.querySelector('#new-query').disabled`);
  await js(`document.querySelector('#new-query').click()`);
  for(const accept of ['Tab','Enter']){
   await type('SELECT * FROM pro');await until(`document.querySelector('#query').getAttribute('aria-expanded')==='true'`);
   await key(accept);assert.equal(await js(`document.querySelector('#query').value`),'SELECT * FROM `proyectos`');
   assert.equal(await js(`document.activeElement.id`),'query');
  }
  const sql='SELECT p.no FROM proyectos p';await type(sql,11);
  await until(`Array.from(document.querySelectorAll('#table-completions .completion-option')).some(x=>x.textContent.includes('nombre'))`);
  await key('Tab');assert.equal(await js(`document.querySelector('#query').value`),'SELECT p.`nombre` FROM proyectos p');
  await type('SELECT 1');await key('Tab');assert.equal(await js(`document.querySelector('#query').value`),'SELECT 1\t');
  console.log('PASS: Tab and Enter accept tables, Tab accepts fields, and Tab indents without suggestions');
  clearTimeout(timeout);await fixture.close();app.exit(0);
 }catch(error){console.error(error);clearTimeout(timeout);await fixture.close();app.exit(1);}
});
