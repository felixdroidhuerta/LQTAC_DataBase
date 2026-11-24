const {app,BrowserWindow,clipboard}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SQLiteAdapter}=require('../src/adapters/sqlite.cjs');let database,memory='';const open=SQLiteAdapter.open;SQLiteAdapter.open=async()=>{const adapter=await open();database=adapter.database;return adapter;};clipboard.writeText=text=>{memory=text;};clipboard.readText=()=>memory;
app.disableHardwareAcceleration();app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'dbfox-diagnostics-')));app.on('browser-window-created',(_e,w)=>{w.hide();w.webContents.setBackgroundThrottling(false);});require('../src/main.cjs');
const timer=setTimeout(()=>{console.error('Diagnostics timed out');app.exit(1);},45000);
app.whenReady().then(async()=>{
 const w=BrowserWindow.getAllWindows()[0],js=code=>w.webContents.executeJavaScript(code),until=expression=>js(`new Promise((resolve,reject)=>{const start=Date.now();function poll(){if(${expression})return resolve();if(Date.now()-start>10000)return reject(Error('Timeout: '+${JSON.stringify(expression)}));setTimeout(poll,40)}poll()})`);
 const paste=async(row,column,value)=>{memory=value;await js(`document.querySelector('#results tr[data-row-index="${row}"] td[data-column="${column}"]').click();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'v',ctrlKey:true,bubbles:true,cancelable:true}))`);await until(`document.querySelector('#results tr[data-row-index="${row}"] td[data-column="${column}"]').copyValue===${JSON.stringify(value)}`);};
 try{
  if(w.webContents.isLoading())await new Promise(r=>w.webContents.once('did-finish-load',r));w.setContentSize(1440,940);
  await js(`document.querySelector('#demo-lab').click()`);await until(`document.querySelector('#connection-label').textContent.includes('Laboratorio')&&!document.querySelector('#new-query').disabled`);await js(`document.querySelector('#new-query').click()`);
  database.run("CREATE TABLE diagnosed(id INTEGER PRIMARY KEY,name TEXT UNIQUE,qty INTEGER);WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<130) INSERT INTO diagnosed SELECT x,'Row '||x,x FROM n");
  await js(`document.querySelector('#query').value='SELECT * FROM diagnosed ORDER BY id';document.querySelector('#query').dispatchEvent(new Event('input'));document.querySelector('#query').setSelectionRange(0,0);document.querySelector('#run-query').click()`);
  await until(`document.querySelectorAll('#results tbody tr').length===100&&!document.querySelector('#run-query').disabled`);
  await js(`document.querySelector('[aria-label="Última página"]').click()`);await paste(116,2,'invalid');await paste(117,2,'also invalid');
  await js(`document.querySelector('#result-filter-value').value='Row 2';document.querySelector('#result-filter-value').dispatchEvent(new Event('input'))`);await until(`!document.querySelector('#results tr[data-row-index="116"]')`);
  await js(`document.querySelector('#apply-result-data').click()`);await until(`document.querySelector('#edit-diagnostics-dialog').open`);
  const message=await js(`document.querySelector('#edit-diagnostics-dialog').textContent`);assert.match(message,/2 error/);assert.match(message,/Consulta/);assert.match(message,/Respuesta 1/);assert.match(message,/main.diagnosed/);assert.match(message,/id=117/);assert.match(message,/qty/);assert.match(message,/invalid/);assert.match(message,/117/);
  assert.equal(database.exec('SELECT qty FROM diagnosed WHERE id=117')[0].values[0][0],117);
  await js(`Array.from(document.querySelectorAll('#edit-diagnostics-dialog button')).find(b=>b.textContent==='Copiar detalles').click()`);await until(`document.querySelector('#toast').textContent.includes('copiados')`);
  const report=JSON.parse(memory);assert.equal(report.diagnostics.total,2);assert.equal(report.output,undefined);assert.match(report.sql,/SELECT \*/);
  await js(`window.dbfoxAppearance.apply({...window.dbfoxAppearance.read(),mode:'dark'});undefined`);await js('new Promise(r=>setTimeout(r,200))');const out=path.resolve(__dirname,'../../tmp/pdfs');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'edit-diagnostics-dark.png'),(await w.webContents.capturePage()).toPNG());
  await js(`Array.from(document.querySelectorAll('#edit-diagnostics-dialog button')).find(b=>b.textContent==='Ir a celda').click()`);
  await until(`document.querySelector('#results tr[data-row-index="116"] td[data-column="2"]')?.classList.contains('data-cell-error')`);
  assert.equal(await js(`document.querySelector('#result-filter-value').value`),'');assert.match(await js(`document.querySelector('#result-page-info').textContent`),/Página 2/);
  await paste(116,2,'98');await paste(117,2,'99');await js(`document.querySelector('#apply-result-data').click()`);await until(`document.querySelector('#confirm-result-changes')?.hidden===false`);
  await js(`document.querySelector('#confirm-result-changes').click()`);await until(`document.querySelectorAll('#results .data-cell-dirty').length===0&&!document.querySelector('#run-query').disabled`);
  assert.deepEqual(database.exec('SELECT qty FROM diagnosed WHERE id IN (117,118) ORDER BY id')[0].values,[[98],[99]]);
  await js(`document.querySelector('[aria-label="Primera página"]').click()`);await paste(0,1,'Row 2');await js(`document.querySelector('#apply-result-data').click()`);await until(`document.querySelector('#confirm-result-changes')?.hidden===false`);await js(`document.querySelector('#confirm-result-changes').click()`);
  await until(`document.querySelector('#edit-diagnostics-dialog').open`);const failure=await js(`document.querySelector('#edit-diagnostics-dialog').textContent`);assert.match(failure,/UNIQUE/);assert.match(failure,/id=1/);assert.match(failure,/Row 2/);assert.match(failure,/UPDATE/);assert.equal(database.exec('SELECT name FROM diagnosed WHERE id=1')[0].values[0][0],'Row 1');
  console.log('PASS: persistent validation and server error details, exact query/response/keys/values, copy details and reveal hidden off-page cell');clearTimeout(timer);app.exit(0);
 }catch(error){console.error(error);console.error(await js(`document.querySelector('#edit-diagnostics-dialog')?.textContent`));clearTimeout(timer);app.exit(1);}
});
