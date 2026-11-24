const {app,BrowserWindow,dialog}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {startMySQLFixture}=require('./mysql-fixture.cjs');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dbfox-compare-'));app.setPath('userData',directory);app.disableHardwareAcceleration();
app.on('browser-window-created',(_e,w)=>{w.hide();w.webContents.setBackgroundThrottling(false);});
dialog.showSaveDialog=async()=>({canceled:false,filePath:path.join(directory,'report.json')});
require('../src/main.cjs');
const timer=setTimeout(()=>{console.error('Comparison timed out');app.exit(1);},45000);
const object=(type,name,ddl,error=null)=>({type,name,ddl,error});
const definitions={test:[
 object('trigger','audit_lead','CREATE DEFINER=`one`@`localhost` TRIGGER `test`.`audit_lead`\nBEFORE INSERT ON `test`.`leads`\nFOR EACH ROW\nBEGIN\n  SET NEW.estado = 1;\nEND'),
 object('view','vista','CREATE DEFINER=`one`@`localhost` VIEW `test`.`vista` AS SELECT 1'),
 object('procedure','actualizar','CREATE PROCEDURE actualizar() SELECT 1'),
 object('function','denied','','Definition access denied')
],asterisk:[
 object('trigger','audit_lead','CREATE DEFINER=`two`@`localhost` TRIGGER `asterisk`.`audit_lead`\nBEFORE INSERT ON `asterisk`.`leads`\nFOR EACH ROW\nBEGIN\n  SET NEW.estado = 2;\n  SET NEW.intentos = 0;\nEND'),
 object('view','vista','CREATE DEFINER=`two`@`localhost` VIEW `asterisk`.`vista` AS SELECT 1'),
 object('function','calcular','CREATE FUNCTION calcular() RETURNS INT RETURN 3')
]};
definitions.test[0].table='leads';definitions.asterisk[0].table='leads_archive';
definitions.asterisk[0].ddl=definitions.asterisk[0].ddl.replace('`asterisk`.`leads`','`asterisk`.`leads_archive`');
app.whenReady().then(async()=>{
 const w=BrowserWindow.getAllWindows()[0],fixture=await startMySQLFixture({comparisonDefinitions:definitions}),js=code=>w.webContents.executeJavaScript(code);let slow;
 const until=expression=>js(`new Promise((resolve,reject)=>{const start=Date.now();function poll(){if(${expression})return resolve();if(Date.now()-start>12000)return reject(Error('Timeout: '+${JSON.stringify(expression)}));setTimeout(poll,40)}poll()})`);
 try{
  if(w.webContents.isLoading())await new Promise(r=>w.webContents.once('did-finish-load',r));w.setContentSize(1440,940);
  const profile=await js(`window.lqtac.saveConnection(${JSON.stringify(fixture.profile)})`);
  await js(`window.lqtac.connectProfile(${JSON.stringify(profile.id)},'fixture-test-password',true)`);
  const before=await js('window.lqtac.status()');
  await js(`document.querySelector('[data-view="schema-compare"]').click()`);
  await until(`document.querySelector('#compare-schema-b').options.length>0`);
  await js(`document.querySelector('#compare-schema-b').value='asterisk';document.querySelector('#compare-load').click()`);
  await until(`!document.querySelector('#compare-export').disabled`);
  assert.equal(await js(`document.querySelectorAll('#compare-list .compare-object').length`),5);
  assert.equal(await js(`document.querySelector('#compare-list [data-name=vista]').dataset.status`),'equal');
  assert.equal(await js(`document.querySelector('#compare-list [data-name=audit_lead]').dataset.status`),'modified');
  assert.equal(await js(`document.querySelector('#compare-list [data-name=denied]').dataset.status`),'error');
  assert.equal(await js(`document.querySelector('#compare-list [data-name=actualizar]').dataset.status`),'only-a');
  assert.equal(await js(`document.querySelector('#compare-list [data-name=calcular]').dataset.status`),'only-b');
  assert.equal(await js(`document.querySelector('[data-view=connections] svg')!==null`),true);
  assert.match(await js(`document.querySelector('#compare-list [data-name=audit_lead]').textContent`),/leads_archive/);
  for(const table of ['leads','leads_archive']){
   await js(`document.querySelector('#compare-table').value=${JSON.stringify(table)};document.querySelector('#compare-table').dispatchEvent(new Event('change'))`);
   assert.equal(await js(`document.querySelectorAll('#compare-list .compare-object').length`),1);
   assert.match(await js(`document.querySelector('#compare-trigger-tables').textContent`),/test.leads.*asterisk.leads_archive/);
  }
  await js(`document.querySelector('#compare-type').value='view';document.querySelector('#compare-type').dispatchEvent(new Event('change'))`);
  assert.equal(await js(`document.querySelector('#compare-table').value`),'');
  assert.equal(await js(`document.querySelector('#compare-trigger-tables').hidden`),true);
  await js(`document.querySelector('#compare-type').value='';document.querySelector('#compare-type').dispatchEvent(new Event('change'))`);
  await js(`document.querySelector('#compare-list [data-name=audit_lead]').click();document.querySelector('#compare-next').click()`);
  assert.ok(await js(`document.querySelectorAll('#compare-code-a .modified').length>0`));
  assert.ok(await js(`document.querySelectorAll('#compare-code-a mark').length>0`));
  assert.ok(await js(`document.querySelectorAll('#compare-code-b .added').length>0`));
  assert.equal((await js('window.lqtac.status()')).database,before.database);
  assert.equal((await js('window.lqtac.connectionOverview()')).sessions.length,1);
  assert.ok(fixture.handshakes.length>=3,'Comparison uses isolated workers');
  await js(`document.querySelector('#compare-ignoreDefiner').click()`);
  assert.equal(await js(`document.querySelector('#compare-list [data-name=vista]').dataset.status`),'modified');
  await js(`document.querySelector('#compare-ignoreDefiner').click();document.querySelector('#compare-export').click()`);
  await until(`document.querySelector('#toast').textContent.includes('exportado')`);
  const report=JSON.parse(fs.readFileSync(path.join(directory,'report.json'),'utf8'));assert.equal(report.objects.length,5);
  assert.equal(report.objects.find(o=>o.type==='trigger').left.table,'leads');
  assert.equal(report.sources[1].schema,'asterisk');assert.ok(!JSON.stringify(report).includes('fixture-test-password'));
  const out=path.resolve(__dirname,'../../tmp/pdfs');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'compare-light.png'),(await w.webContents.capturePage()).toPNG());
  await js(`document.querySelector('#toggle-theme').click()`);await js('new Promise(r=>setTimeout(r,150))');
  const background=await js(`getComputedStyle(document.querySelector('.compare-pane')).backgroundColor`);assert.notEqual(background,'rgb(255, 255, 255)');
  fs.writeFileSync(path.join(out,'compare-dark.png'),(await w.webContents.capturePage()).toPNG());
  assert.equal(await js('document.body.scrollWidth<=innerWidth'),true);
  await assert.rejects(js(`window.lqtac.readComparison({key:${JSON.stringify(profile.id)},schema:'unknown',runId:'bad-schema'})`),/catálogo/);
  assert.ok(fixture.queries.every(sql=>!/^(CREATE|DROP|ALTER|INSERT|UPDATE|DELETE)\b/.test(sql)),'No writes sent');
  slow=await startMySQLFixture({comparisonDefinitions:definitions,comparisonDelayMs:2500});
  const slowProfile=await js(`window.lqtac.saveConnection(${JSON.stringify({...slow.profile,name:'Servidor lento'})})`);
  await js(`window.lqtac.connectProfile(${JSON.stringify(slowProfile.id)},'fixture-test-password',false)`);
  await js(`window.lqtac.saveSettings({queryTimeoutSeconds:1})`);
  await assert.rejects(js(`window.lqtac.readComparison({key:${JSON.stringify(slowProfile.id)},schema:'test',runId:'timeout'})`),/máximo|tiempo|Timeout|timeout/);
  assert.equal((await js('window.lqtac.status()')).connected,true);
  await js(`window.lqtac.saveSettings({queryTimeoutSeconds:30})`);
  await js(`window.comparisonPending=window.lqtac.readComparison({key:${JSON.stringify(slowProfile.id)},schema:'test',runId:'cancel'}).then(()=>'',e=>e.message);undefined`);
  await new Promise(r=>setTimeout(r,100));await js(`window.lqtac.cancelComparison('cancel')`);
  assert.match(await js('window.comparisonPending'),/cancelada/);
  assert.equal((await js('window.lqtac.status()')).connected,true);
  console.log('PASS: comparisons across schemas, all statuses, code diffs, ignored DEFINER, export, themes and isolated read-only sessions');
  clearTimeout(timer);await slow?.close();await fixture.close();app.exit(0);
 }catch(error){console.error(error);console.error(await js(`document.querySelector('#compare-status')?.textContent`));clearTimeout(timer);await slow?.close();await fixture.close();app.exit(1);}
});
