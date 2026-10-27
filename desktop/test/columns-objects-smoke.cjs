const {app,BrowserWindow}=require('electron');app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
const assert=require('node:assert/strict');const fs=require('node:fs');const {join}=require('node:path');const {tmpdir}=require('node:os');const {startMySQLFixture}=require('./mysql-fixture.cjs');
const directory=fs.mkdtempSync(join(tmpdir(),'lqtac-columns-objects-'));app.setPath('userData',directory);require('../src/main.cjs');const timeout=setTimeout(()=>{console.error('Columns/object smoke timed out');app.exit(1);},40000);
app.whenReady().then(async()=>{const window=BrowserWindow.getAllWindows()[0];window.webContents.setBackgroundThrottling(false);const fixture=await startMySQLFixture();try{
  if(window.webContents.isLoading())await new Promise(resolve=>window.webContents.once('did-finish-load',resolve));const js=code=>window.webContents.executeJavaScript(code);const until=condition=>js(`new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(${condition})return resolve();if(Date.now()-start>8000)return reject(new Error(${JSON.stringify(condition)}));setTimeout(poll,30)};poll()})`);
  const profile=await js(`window.lqtac.saveConnection(${JSON.stringify(fixture.profile)})`);await js(`window.lqtac.connectProfile(${JSON.stringify(profile.id)},'fixture')`);
  await js('document.querySelector("[data-view=connections]").click()');await until('document.querySelector(".profile-row .primary")');await js('document.querySelector(".profile-row .primary").click()');await until('document.querySelector("#connection-label").textContent.includes("Servidor")');
  await js(`(()=>{const e=document.querySelector('#query');e.value='SELECT p.no FROM proyectos p';e.focus();e.setSelectionRange(11,11);e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await until('document.querySelector(".completion-option")?.textContent.includes("nombre")');assert.match(await js('document.querySelector(".completion-option").textContent'),/Campo/);
  await js(`document.querySelector('#query').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);assert.match(await js('document.querySelector("#query").value'),/p\.`nombre`/);
  const direct=await js(`window.lqtac.columns([{schema:'test',name:'proyectos'}],${JSON.stringify(profile.id)})`);assert.equal(direct[0].columns[1].name,'nombre');
  for(const [type,name,oldText,newText] of [['view','vista','SELECT id,nombre','SELECT id'],['procedure','actualizar','SELECT 1','SELECT 2'],['function','calcular','RETURN n+1','RETURN n+2']]){
    const selector=`.edit-object[data-schema="test"][data-object="${name}"][data-type="${type}"]`;
    await until(`document.querySelector(${JSON.stringify(selector)})`);await js(`document.querySelector(${JSON.stringify(selector)}).click()`);await until('document.querySelector("#object-editor-dialog").open');
    await js(`document.querySelector('#object-source').value=document.querySelector('#object-source').value.replace(${JSON.stringify(oldText)},${JSON.stringify(newText)});document.querySelector('#object-source').dispatchEvent(new Event('input'));document.querySelector('#object-preview').click()`);await until('!document.querySelector("#object-apply").disabled');
    assert.equal(fixture.queries.some(sql=>sql.startsWith('DROP '+type.toUpperCase())&&sql.includes(name)),false);
    await js('document.querySelector("#object-apply").click()');await until('!document.querySelector("#object-editor-dialog").open');
    const current=await js(`window.lqtac.inspectObject(${JSON.stringify({schema:'test',name,type})},${JSON.stringify(profile.id)})`);assert.ok(current.ddl.includes(newText));
  }
  const before=fixture.queries.filter(sql=>/^DROP|^CREATE/.test(sql)).length;const original=await js(`window.lqtac.inspectObject({schema:'test',name:'calcular',type:'function'},${JSON.stringify(profile.id)})`);
  const plan=await js(`window.lqtac.previewObject(${JSON.stringify({target:{schema:'test',name:'calcular',type:'function'},version:original.version,sql:original.ddl.replace('n+2','n+3')})},${JSON.stringify(profile.id)})`);
  await assert.rejects(js(`window.lqtac.applyObject(${JSON.stringify(plan.token)},'wrong-session')`),/conexión/);assert.equal(fixture.queries.filter(sql=>/^DROP|^CREATE/.test(sql)).length,before);
  assert.equal(fs.readdirSync(join(directory,'object-backups')).length,3);assert.ok(fixture.handshakes.length>=4,'Edits use independent native sessions');
  console.log('PASS: alias column completion/Enter, metadata IPC, native view/procedure/function editor, review without writes, explicit apply, backups, isolated sessions and session guard');
  clearTimeout(timeout);await fixture.close();app.exit(0);
}catch(error){console.error(error);clearTimeout(timeout);await fixture.close();app.exit(1);}});
