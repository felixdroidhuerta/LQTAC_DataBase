const {app,BrowserWindow,clipboard}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SQLiteAdapter}=require('../src/adapters/sqlite.cjs');let database,memory='';const original=SQLiteAdapter.open;
SQLiteAdapter.open=async()=>{const adapter=await original();database=adapter.database;return adapter;};clipboard.writeText=text=>{memory=text;};clipboard.readText=()=>memory;
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'dbfox-cell-clipboard-')));app.disableHardwareAcceleration();app.on('browser-window-created',(_e,w)=>{w.hide();w.webContents.setBackgroundThrottling(false);});require('../src/main.cjs');
const timer=setTimeout(()=>{console.error('Cell clipboard and resize timed out');app.exit(1);},35000);
app.whenReady().then(async()=>{
 const w=BrowserWindow.getAllWindows()[0],js=code=>w.webContents.executeJavaScript(code);
 const until=condition=>js(`new Promise((resolve,reject)=>{const start=Date.now();function poll(){if(${condition})return resolve();if(Date.now()-start>9000)return reject(Error('Timeout: '+${JSON.stringify(condition)}));setTimeout(poll,35)}poll()})`);
 const key=async(keyCode,modifiers=['control'])=>{w.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});w.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await js('new Promise(r=>setTimeout(r,70))');};
 const run=async sql=>{await js(`document.querySelector('#query').value=${JSON.stringify(sql)};document.querySelector('#query').dispatchEvent(new Event('input'));document.querySelector('#query').setSelectionRange(0,0);document.querySelector('#run-query').click()`);await until(`!document.querySelector('#run-query').disabled&&!!document.querySelector('#results tbody td')`);};
 try{
  if(w.webContents.isLoading())await new Promise(r=>w.webContents.once('did-finish-load',r));w.setContentSize(1440,940);
  await js(`document.querySelector('#demo-lab').click()`);await until(`document.querySelector('#connection-label').textContent.includes('Laboratorio')&&!document.querySelector('#new-query').disabled`);await js(`document.querySelector('#new-query').click()`);
  const payload='{"field":"a,b;c"}\nsecond\tline '+ 'long text '.repeat(70);
  database.run('CREATE TABLE cell_edits(id INTEGER PRIMARY KEY,value TEXT,quantity INTEGER DEFAULT NULL)');database.run('INSERT INTO cell_edits VALUES(1,?,3),(2,?,7)',[payload,'original']);
  await run('SELECT * FROM cell_edits ORDER BY id');
  const before=await js(`document.querySelector('#results thead th:nth-child(3)').getBoundingClientRect().width`);
  const rect=await js(`(()=>{const r=document.querySelector('#results thead th:nth-child(3) .result-column-resizer').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  w.webContents.sendInputEvent({type:'mouseMove',...rect});w.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...rect});w.webContents.sendInputEvent({type:'mouseMove',x:rect.x+130,y:rect.y});w.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:rect.x+130,y:rect.y});
  await until(`document.querySelector('#results thead th:nth-child(3)').getBoundingClientRect().width>${before+90}`);
  const resized=await js(`document.querySelector('#results thead th:nth-child(3)').getBoundingClientRect().width`);
  assert.equal(await js(`document.querySelector('#results thead th:nth-child(3)').getAttribute('aria-sort')`),'none');
  await js(`document.querySelector('#results thead th:nth-child(2) .result-sort').click()`);
  assert.ok(Math.abs((await js(`document.querySelector('#results thead th:nth-child(3)').getBoundingClientRect().width`))-resized)<2);
  await js(`document.querySelector('#results tr[data-row-index="0"] td[data-column="1"]').click()`);await key('C');assert.equal(memory,payload);
  assert.equal(await js(`document.querySelectorAll('.data-cell-input').length`),0);
  await js(`document.querySelector('#results tr[data-row-index="1"] td[data-column="1"]').click()`);await key('V');
  await until(`document.querySelector('#results tr[data-row-index="1"] td[data-column="1"]').classList.contains('data-cell-dirty')`);
  assert.equal(await js(`document.querySelector('#results tr[data-row-index="1"] td[data-column="1"]').copyValue`),payload);
  assert.equal(database.exec('SELECT value FROM cell_edits WHERE id=2')[0].values[0][0],'original');
  assert.equal(await js(`document.querySelectorAll('.data-cell-input').length`),0);
  memory='';await js(`document.querySelector('#results tr[data-row-index="1"] td[data-column="2"]').click()`);await key('V');
  await until(`document.querySelector('#results tr[data-row-index="1"] td[data-column="2"]').textContent==='NULL'`);
  assert.equal(database.exec('SELECT quantity FROM cell_edits WHERE id=2')[0].values[0][0],7);
  await js(`document.querySelector('#apply-result-data').click()`);await until(`document.querySelector('#confirm-result-changes')`);
  assert.equal(database.exec('SELECT value FROM cell_edits WHERE id=2')[0].values[0][0],'original');
  await js(`document.querySelector('#confirm-result-changes').click()`);await until(`document.querySelectorAll('#results .data-cell-dirty').length===0`);
  assert.deepEqual(database.exec('SELECT value,quantity FROM cell_edits WHERE id=2')[0].values[0],[payload,null]);
  // Repeated Ctrl+C still copies the selected cell, never a truncated preview.
  await js(`document.querySelector('#results tr[data-row-index="1"] td[data-column="1"]').click()`);await key('C');assert.equal(memory,payload);
  await run('SELECT value FROM cell_edits');memory='must not write';await js(`document.querySelector('#results tbody td').click()`);await key('V');
  await until(`document.querySelector('#toast').textContent.includes('solo lectura')`);
  assert.equal(database.exec('SELECT value FROM cell_edits WHERE id=2')[0].values[0][0],payload);
  console.log('PASS: drag column resize without sorting, retained widths, single-click Ctrl+C/V, full multiline cell content, NULL, explicit SQL apply and read-only protection');clearTimeout(timer);app.exit(0);
 }catch(error){console.error(error);console.error(await js(`document.querySelector('#toast').textContent`));clearTimeout(timer);app.exit(1);}
});
