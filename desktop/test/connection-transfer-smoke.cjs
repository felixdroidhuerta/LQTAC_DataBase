const {app,BrowserWindow,dialog}=require('electron');
const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path'); const assert=require('node:assert/strict');
const {startMySQLFixture}=require('./mysql-fixture.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lqtac-connection-transfer-'));app.setPath('userData',dir);
app.on('browser-window-created',(_event,w)=>{w.hide();w.webContents.setBackgroundThrottling(false);});
const file=path.join(dir,'connections.foxdb'),legacy=path.join(dir,'connections.lqtdb');let importFile=file;
dialog.showSaveDialog=async(_window,options)=>{assert.match(options.defaultPath,/\.foxdb$/);assert.deepEqual(options.filters[0].extensions,['foxdb']);return {canceled:false,filePath:file};};
dialog.showOpenDialog=async(_window,options)=>{assert.ok(options.filters[0].extensions.includes('foxdb'));assert.ok(options.filters[0].extensions.includes('lqtdb'));return {canceled:false,filePaths:[importFile]};};
require('../src/main.cjs');
const timeout=setTimeout(()=>{console.error('Connection transfer timed out');app.exit(1);},40000);
app.whenReady().then(async()=>{
 const w=BrowserWindow.getAllWindows()[0],fixture=await startMySQLFixture();const js=code=>w.webContents.executeJavaScript(code);
 const until=expression=>js(`new Promise((resolve,reject)=>{let start=Date.now();function poll(){if(${expression})return resolve();if(Date.now()-start>10000)return reject(Error('Timeout: '+${JSON.stringify(expression)}));setTimeout(poll,50)}poll()})`);
 try {
  if(w.webContents.isLoading())await new Promise(r=>w.webContents.once('did-finish-load',r));
  const profile=await js(`window.lqtac.saveConnection(${JSON.stringify({...fixture.profile,name:'Copia'})})`);
  await js(`window.lqtac.createConnectionGroup('Grupo de prueba',[${JSON.stringify(profile.id)}])`);
  await js(`window.lqtac.connectProfile(${JSON.stringify(profile.id)},'fixture-test-password',true)`);
  await js(`window.lqtac.disconnectConnection(${JSON.stringify(profile.id)})`);
  await js(`document.querySelector('#export-connections').click();document.querySelector('#connection-backup-password').value='clave segura 123';document.querySelector('#connection-backup-confirm').value='clave segura 123';document.querySelector('#connection-backup-form').requestSubmit()`);
  await until("!document.querySelector('#connection-backup-dialog').open");
  assert.ok(fs.existsSync(file));assert.ok(!fs.readFileSync(file,'utf8').includes('fixture-test-password'));
  const modern=await js('window.lqtac.prepareConnectionImport("clave segura 123")');assert.equal(modern.profiles,1);await js(`window.lqtac.cancelConnectionImport(${JSON.stringify(modern.token)})`);
  fs.copyFileSync(file,legacy);importFile=legacy;
  await js(`window.lqtac.saveConnection(${JSON.stringify({...fixture.profile,name:'Temporal'})})`);
  await js(`window.confirm=()=>true;document.querySelector('#import-connections').click();document.querySelector('#connection-backup-password').value='clave segura 123';document.querySelector('#connection-backup-form').requestSubmit()`);
  await until("!document.querySelector('#connection-backup-dialog').open");
  const overview=await js('window.lqtac.connectionOverview()');assert.equal(overview.profiles.length,1);assert.equal(overview.profiles[0].id,profile.id);assert.deepEqual(overview.groups[0].connectionIds,[profile.id]);
  assert.equal((await js(`window.lqtac.credentialStatus(${JSON.stringify(profile.id)})`)).saved,true);
  await js(`window.lqtac.connectProfile(${JSON.stringify(profile.id)},null,true)`);
  console.log('PASS: exportación .foxdb e importación de .foxdb y .lqtdb con grupos y contraseña');
 } finally {await fixture.close();clearTimeout(timeout);app.exit();}
}).catch(error=>{console.error(error);clearTimeout(timeout);app.exit(1);});
