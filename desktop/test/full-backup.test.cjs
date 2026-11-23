const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {ConnectionStore}=require('../src/connections.cjs');
const {CredentialStore}=require('../src/credentials.cjs');
const {DashboardStore}=require('../src/dashboards.cjs');
const {collectBackup,encryptBackup,decryptBackup,restoreBackup}=require('../src/full-backup.cjs');
const storage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('encrypted:'+s),decryptString:b=>b.toString().slice(10)};
test('full encrypted backup restores connections, passwords, groups, dashboards, settings and drafts on another installation',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dbfox-full-'));
 try{
  const source=path.join(root,'source'),target=path.join(root,'target'),connections=new ConnectionStore(source),credentials=new CredentialStore(source,storage);
  const profile=await connections.save({engine:'mysql',name:'Servidor',host:'127.0.0.1',port:3306,username:'user',database:'db'});
  await credentials.set(profile.id,'secret-database-password');await connections.createGroup('Grupo',[profile.id]);
  await new DashboardStore(source).save({format:'LQTAC Dashboard',version:1,id:'board-one',name:'Informe',revision:0,connection:{key:profile.id,name:'Servidor'},datasets:[],widgets:[]});
  await fs.writeFile(path.join(source,'settings.json'),JSON.stringify({queryTimeoutSeconds:85,maxStatements:100}));
  await fs.writeFile(path.join(source,'sql-favorites.json'),JSON.stringify([{id:'favorite',name:'Consulta',sql:'SELECT 1'}]));
  const state={'lqtac.queries':'[{"sql":"SELECT 1"}]'};
  const {backup,summary}=await collectBackup(source,connections,credentials,state,'0.2.6');
  assert.equal(summary.passwords,1);assert.equal(summary.dashboards,1);assert.equal(summary.favorites,1);
  const encrypted=await encryptBackup(backup,'secure-file-password');assert.ok(!encrypted.includes('secret-database-password'));
  await assert.rejects(decryptBackup(encrypted,'wrong-password'),/incorrecta/);
  const decoded=await decryptBackup(encrypted,'secure-file-password');
  const dest=new ConnectionStore(target),secrets=new CredentialStore(target,storage);
  await dest.save({engine:'mysql',name:'Anterior',host:'localhost',port:3306,username:'old'});
  const result=await restoreBackup(target,dest,secrets,decoded);
  assert.deepEqual(await dest.list(),await connections.list());assert.deepEqual(await dest.groups(),await connections.groups());
  assert.equal(await secrets.get(profile.id),'secret-database-password');assert.deepEqual(result.localStorage,state);
  assert.equal((await new DashboardStore(target).read('board-one')).name,'Informe');
  assert.equal(JSON.parse(await fs.readFile(path.join(target,'settings.json'),'utf8')).queryTimeoutSeconds,85);
  assert.ok((await fs.readFile(path.join(result.backupDir,'connections.json'),'utf8')).includes('Anterior'));
  await assert.rejects(encryptBackup({...backup,files:{'../outside.json':'{}'}},'secure-file-password'),/no permitido/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
