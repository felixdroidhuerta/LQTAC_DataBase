const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {startMySQLFixture}=require('./mysql-fixture.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dbfox-compare-edit-'));app.setPath('userData',dir);app.disableHardwareAcceleration();
app.on('browser-window-created',(_e,w)=>{w.hide();w.webContents.setBackgroundThrottling(false);});require('../src/main.cjs');
const timer=setTimeout(()=>{console.error('Comparison editing timed out');app.exit(1);},60000);
app.whenReady().then(async()=>{
 const w=BrowserWindow.getAllWindows()[0],a=await startMySQLFixture(),b=await startMySQLFixture(),js=code=>w.webContents.executeJavaScript(code);
 const until=expression=>js(`new Promise((resolve,reject)=>{const start=Date.now();function poll(){if(${expression})return resolve();if(Date.now()-start>12000)return reject(Error('Timeout: '+${JSON.stringify(expression)}));setTimeout(poll,40)}poll()})`);
 const writes=fixture=>fixture.queries.filter(sql=>/^(CREATE|DROP|ALTER|GRANT)\b/.test(sql));
 const manual='SET NEW.nombre = LOWER(NEW.nombre)';
 try{
  if(w.webContents.isLoading())await new Promise(r=>w.webContents.once('did-finish-load',r));w.setContentSize(1440,940);
  b.setTriggerBody('audit_proyectos','SET NEW.nombre = UPPER(NEW.nombre)');
  const profiles=[];for(const [fixture,name]of [[a,'Destino A'],[b,'Referencia B']]){const p=await js(`window.lqtac.saveConnection(${JSON.stringify({...fixture.profile,name})})`);profiles.push(p);await js(`window.lqtac.connectProfile(${JSON.stringify(p.id)},'fixture-test-password',true)`);}
  const before=await js('window.lqtac.status()');
  await js(`window.confirm=()=>true;document.querySelector('[data-view="schema-compare"]').click()`);
  await until(`document.querySelector('#compare-schema-b').value==='test'`);await js(`document.querySelector('#compare-load').click()`);await until(`!document.querySelector('#compare-export').disabled`);
  await js(`document.querySelector('#compare-list [data-name=audit_proyectos]').click();document.querySelector('#compare-edit-a').click()`);
  await until(`document.querySelector('#comparison-edit-dialog').open && !document.querySelector('#comparison-edit-preview').disabled`);
  assert.match(await js(`document.querySelector('#comparison-edit-target').textContent`),/Destino A.*test.audit_proyectos/);
  assert.match(await js(`document.querySelector('#comparison-edit-source').value`),/TRIM/);
  await js(`document.querySelector('#comparison-edit-source').value=${JSON.stringify(manual)};document.querySelector('#comparison-edit-source').dispatchEvent(new Event('input'));document.querySelector('#comparison-edit-preview').click()`);
  await until(`!document.querySelector('#comparison-edit-apply').disabled`);
  assert.match(await js(`document.querySelector('#comparison-edit-sql').textContent`),/DROP TRIGGER[\s\S]*LOWER/);
  assert.equal(writes(a).length,0);assert.equal(writes(b).length,0);
  await js(`document.querySelector('#comparison-edit-close').click();document.querySelector('#compare-take-a').click()`);
  await until(`document.querySelector('#comparison-edit-dialog').open && !document.querySelector('#comparison-edit-preview').disabled`);
  assert.match(await js(`document.querySelector('#comparison-edit-source').value`),/UPPER/);
  await js(`document.querySelector('#comparison-edit-source').value=${JSON.stringify(manual)};document.querySelector('#comparison-edit-source').dispatchEvent(new Event('input'));document.querySelector('#comparison-edit-preview').click()`);
  await until(`!document.querySelector('#comparison-edit-apply').disabled`);
  await js(`window.dbfoxAppearance.apply({...window.dbfoxAppearance.read(),mode:'dark'})`);assert.notEqual(await js(`getComputedStyle(document.querySelector('#comparison-edit-dialog')).backgroundColor`),'rgb(255, 255, 255)');
  await js('new Promise(r=>setTimeout(r,200))');
  const out=path.resolve(__dirname,'../../tmp/pdfs');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'comparison-edit-dark.png'),(await w.webContents.capturePage()).toPNG());
  await js(`document.querySelector('#comparison-edit-apply').click();document.querySelector('#comparison-edit-apply').click()`);await until(`!document.querySelector('#comparison-edit-dialog').open`);
  assert.equal(writes(a).filter(sql=>sql.startsWith('DROP TRIGGER')).length,1);assert.equal(writes(b).length,0);
  assert.match(await js(`document.querySelector('#compare-code-a').textContent`),/LOWER/);assert.match(await js(`document.querySelector('#compare-code-b').textContent`),/UPPER/);
  assert.equal((await js('window.lqtac.status()')).sessionKey,before.sessionKey);
  assert.equal(fs.readdirSync(path.join(dir,'comparison-backups')).length,1);
  // Failed CREATE restores the original destination body.
  await js(`document.querySelector('#compare-edit-a').click()`);await until(`document.querySelector('#comparison-edit-dialog').open && !document.querySelector('#comparison-edit-preview').disabled`);
  await js(`document.querySelector('#comparison-edit-source').value='INVALID_BODY';document.querySelector('#comparison-edit-source').dispatchEvent(new Event('input'));document.querySelector('#comparison-edit-preview').click()`);await until(`!document.querySelector('#comparison-edit-apply').disabled`);
  await js(`document.querySelector('#comparison-edit-apply').click()`);await until(`document.querySelector('#comparison-edit-message').textContent.includes('restauró') && !document.querySelector('#comparison-edit-close').disabled`);
  await js(`document.querySelector('#comparison-edit-close').click()`);
  const read=async(profile,type)=>{const data=await js(`window.lqtac.readComparison({key:${JSON.stringify(profile.id)},schema:'test',runId:${JSON.stringify('read-'+Math.random())}})`);return data.objects.find(o=>o.type===type);};
  const trigger=await read(profiles[0],'trigger');assert.match(trigger.ddl,/LOWER/);
  const target={key:profiles[0].id,schema:'test',name:trigger.name,type:'trigger',expectedDDL:trigger.ddl};
  const edit=await js(`window.lqtac.openComparisonEdit({target:${JSON.stringify(target)}})`);
  const review=await js(`window.lqtac.previewComparisonEdit(${JSON.stringify({token:edit.token,text:'SET NEW.nombre = UPPER(NEW.nombre)',timing:'BEFORE',event:'INSERT'})})`);
  const count=writes(a).length;a.setTriggerBody('audit_proyectos','SET NEW.nombre = REVERSE(NEW.nombre)');
  await assert.rejects(js(`window.lqtac.applyComparisonEdit(${JSON.stringify({token:edit.token,reviewToken:review.reviewToken})})`),/ha cambiado/);assert.equal(writes(a).length,count);
  await assert.rejects(js(`window.lqtac.openComparisonEdit({target:${JSON.stringify(target)}})`),/ha cambiado/);
  // Manual view, procedure and function definitions use the same reviewed workflow.
  for(const type of ['view','procedure','function']){
   const object=await read(profiles[0],type),t={key:profiles[0].id,schema:'test',name:object.name,type,expectedDDL:object.ddl};
   const opened=await js(`window.lqtac.openComparisonEdit({target:${JSON.stringify(t)}})`);
   const text=type==='view'?opened.text.replace('SELECT id,nombre','SELECT nombre'):type==='procedure'?opened.text.replace('SELECT 1','SELECT 2'):opened.text.replace('n+1','n+2');
   const preview=await js(`window.lqtac.previewComparisonEdit(${JSON.stringify({token:opened.token,text})})`);if(type!=='view')assert.match(preview.sql,/GRANT/);
   const result=await js(`window.lqtac.applyComparisonEdit(${JSON.stringify({token:opened.token,reviewToken:preview.reviewToken})})`);assert.equal(result.applied,true);assert.ok(result.object);assert.equal(writes(b).length,0);
  }
  assert.equal((await js('window.lqtac.status()')).sessionKey,before.sessionKey);
  console.log('PASS: manual editing, copy as editable draft, SQL review, explicit destination-only apply, backups, restoration, stale-object protection, views and routines');
  clearTimeout(timer);await a.close();await b.close();app.exit(0);
 }catch(error){console.error(error);console.error(await js(`document.querySelector('#comparison-edit-message')?.textContent`));clearTimeout(timer);await a.close();await b.close();app.exit(1);}
});
