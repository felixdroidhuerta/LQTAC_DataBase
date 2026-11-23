const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {startMySQLFixture}=require('../../desktop/test/mysql-fixture.cjs');
app.disableHardwareAcceleration();app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'dbfox-manual-connections-')));
app.on('browser-window-created',(_e,w)=>{w.hide();w.webContents.setBackgroundThrottling(false);});
require('../../desktop/src/main.cjs');
const assets=path.join(__dirname,'assets'),timer=setTimeout(()=>{console.error('Capture timed out');app.exit(1);},35000);
app.whenReady().then(async()=>{
 const w=BrowserWindow.getAllWindows()[0],fixture=await startMySQLFixture(),js=code=>w.webContents.executeJavaScript(code);
 const until=expression=>js(`new Promise((resolve,reject)=>{const start=Date.now();function poll(){if(${expression})return resolve();if(Date.now()-start>10000)return reject(Error('Timeout'));setTimeout(poll,40)}poll()})`);
 async function snap(name,selector){await new Promise(r=>setTimeout(r,350));let rect;if(selector)rect=await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()`);fs.writeFileSync(path.join(assets,name),(await w.webContents.capturePage(rect)).toPNG());console.log(name);}
 try{
  if(w.webContents.isLoading())await new Promise(r=>w.webContents.once('did-finish-load',r));w.setContentSize(1440,940);
  const profiles=[];for(const name of ['Ventas - ejemplo','Informes - ejemplo','Pruebas - ejemplo']){
   const profile=await js(`window.lqtac.saveConnection(${JSON.stringify({...fixture.profile,name})})`);profiles.push(profile.id);
   await js(`window.lqtac.connectProfile(${JSON.stringify(profile.id)},'fixture-test-password',true)`);await js(`window.lqtac.disconnectConnection(${JSON.stringify(profile.id)})`);
  }
  await js(`window.lqtac.createConnectionGroup('Equipo de ejemplo',${JSON.stringify(profiles)})`);
  await js(`document.querySelector('[data-view=connections]').click()`);await until(`document.querySelectorAll('.profile-row').length===3`);
  await js(`document.querySelector('#connect-all-side').click()`);await until(`!document.querySelector('#connect-all-side').disabled`);
  await js(`document.querySelector('#toast').classList.add('hidden')`);
  await snap('28-conectar-todos.png');
  await js(`document.querySelector('#export-all').click()`);await snap('29-copia-completa.png','#connection-backup-dialog');
  fs.writeFileSync(path.join(assets,'connection-updates-info.json'),JSON.stringify({date:'2026-11-23',version:'0.2.6',source:'Aplicación real; fixture MySQL local; perfiles ficticios; ningún servidor real consultado'},null,2));
  clearTimeout(timer);await fixture.close();app.exit(0);
 }catch(error){console.error(error);clearTimeout(timer);await fixture.close();app.exit(1);}
});
