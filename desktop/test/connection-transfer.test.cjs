const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {ConnectionStore}=require('../src/connections.cjs');
const {CredentialStore}=require('../src/credentials.cjs');
const {encryptPackage,decryptPackage,restorePackage}=require('../src/connection-transfer.cjs');
const storage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('encrypted:'+s),decryptString:b=>b.toString().slice(10)};
const profile={id:'profile-1',engine:'mysql',name:'Servidor',host:'10.0.0.1',port:3306,username:'user',database:'db',tls:true};
const payload={format:'LQTAC Connections',version:1,profiles:[profile],groups:[{id:'group-1',name:'Equipo',connectionIds:['profile-1']}],passwords:[{id:'profile-1',password:'servidor secreto'}]};
test('encrypted portable package protects data, detects tampering and restores profiles, groups and passwords',async()=>{
 const encoded=await encryptPackage(payload,'una clave segura');
 assert.ok(!encoded.includes('servidor secreto')); assert.ok(!encoded.includes('10.0.0.1'));
 await assert.rejects(decryptPackage(encoded,'clave incorrecta'),/incorrecta/);
 const bad=JSON.parse(encoded);bad.tag=Buffer.alloc(16).toString('base64');await assert.rejects(decryptPackage(JSON.stringify(bad),'una clave segura'),/dañado/);
 const decoded=await decryptPackage(encoded,'una clave segura');assert.deepEqual(decoded,payload);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lqtac-transfer-'));
 try {const store=new ConnectionStore(dir),secret=new CredentialStore(dir,storage);const old=await store.save({...profile,id:undefined,name:'Anterior'});await secret.set(old.id,'antigua');await restorePackage(store,secret,decoded);assert.deepEqual(await store.list(),[profile]);assert.deepEqual(await store.groups(),payload.groups);assert.equal(await secret.get('profile-1'),'servidor secreto');assert.equal(await secret.has(old.id),false);const backup=JSON.parse(await fs.readFile(path.join(dir,'connections-restore-backup.json'),'utf8'));assert.equal(backup.profiles[0].name,'Anterior');assert.ok(!JSON.stringify(backup).includes('servidor secreto'));}
 finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('invalid references and unavailable secure storage do not modify connections',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lqtac-transfer-'));
 try {const store=new ConnectionStore(dir),secret=new CredentialStore(dir,{...storage,isEncryptionAvailable:()=>false});const original=await store.save(profile);await assert.rejects(restorePackage(store,secret,payload),/seguro/);assert.deepEqual(await store.list(),[original]);await assert.rejects(encryptPackage({...payload,groups:[{id:'g',name:'G',connectionIds:['missing']}]},'12345678'),/grupo/);}
 finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('restore rolls back profiles, groups and passwords if writing fails',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lqtac-transfer-'));
 try {const store=new ConnectionStore(dir),secret=new CredentialStore(dir,storage);const original=await store.save({...profile,name:'Original'});await secret.set(original.id,'old');const write=store.write.bind(store);let fail=true;store.write=async(file,value)=>{if(file===secret.file&&fail){fail=false;throw Error('simulated failure');}return write(file,value);};await assert.rejects(restorePackage(store,secret,payload),/simulated failure/);assert.deepEqual(await store.list(),[original]);assert.deepEqual(await store.groups(),[]);assert.equal(await secret.get(original.id),'old');}
 finally {await fs.rm(dir,{recursive:true,force:true});}
});
