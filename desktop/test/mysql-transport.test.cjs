const {test}=require('node:test');
const assert=require('node:assert/strict');
const {generateKeyPairSync,createHash}=require('node:crypto');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Server}=require('ssh2');
const {mysqlTransport}=require('../src/adapters/mysql-transport.cjs');
const {validateProfile}=require('../src/connections.cjs');
test('TCP y socket conservan el transporte esperado',async()=>{
 assert.deepEqual((await mysqlTransport({})).options,{});
 assert.deepEqual((await mysqlTransport({method:'socket',socketPath:'local'})).options,{socketPath:'local'});
 assert.equal(validateProfile({engine:'mysql',name:'local',host:'localhost',port:3306,username:'test',method:'socket',socketPath:'local'}).socketPath,'local');
});
test('SSH verifica identidad, transmite datos y cierra el canal',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dbfox-ssh-'));
 const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
 const keyPath=path.join(dir,'key');await fs.writeFile(keyPath,key);
 const {utils}=require('ssh2');const fingerprint='SHA256:'+createHash('sha256').update(utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/,'');
 const clients=new Set();
 const server=new Server({hostKeys:[key]},client=>{clients.add(client);client.on('error',()=>{});client.on('authentication',ctx=>ctx.method==='publickey'||(ctx.method==='password'&&ctx.password==='test-secret')?ctx.accept():ctx.reject());client.on('ready',()=>client.on('tcpip',(accept)=>{const channel=accept();channel.on('error',()=>{});channel.on('data',data=>channel.write(data));}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const profile={method:'ssh',sshHost:'127.0.0.1',sshPort:server.address().port,sshUser:'test',sshKeyPath:keyPath,sshFingerprint:fingerprint,host:'database',port:3306};
 try{
  const transport=await mysqlTransport(profile),stream=transport.options.stream();
  const received=new Promise(resolve=>stream.once('data',resolve));stream.write('dbFox');assert.equal(String(await received),'dbFox');transport.close();
  await assert.rejects(mysqlTransport({...profile,sshFingerprint:'SHA256:'+ 'A'.repeat(43)}),/SSH/);
  const passwordTransport=await mysqlTransport({...profile,sshAuth:'password',sshPassword:'test-secret'});
  passwordTransport.close();
  await assert.rejects(mysqlTransport({...profile,sshAuth:'password',sshPassword:'incorrect'}),/SSH/);
 }finally{for(const client of clients)client.end();server.close();await fs.rm(dir,{recursive:true,force:true});}
});
