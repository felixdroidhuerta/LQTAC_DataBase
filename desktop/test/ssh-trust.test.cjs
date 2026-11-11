const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {verifySSHHost}=require('../src/adapters/ssh-trust.cjs');
test('SSH pide confianza inicial, recuerda la identidad y bloquea cambios',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dbfox-trust-'));const file=path.join(dir,'hosts.json'),profile={sshHost:'localhost',sshPort:22};let prompts=0;
 try{
  assert.equal(verifySSHHost(profile,'SHA256:test',{file,confirm:()=>false}),false);assert.equal(fs.existsSync(file),false);
  const options={file,confirm:()=>{prompts++;return true;}};
  assert.equal(verifySSHHost(profile,'SHA256:test',options),true);
  assert.equal(verifySSHHost(profile,'SHA256:test',options),true);assert.equal(prompts,1);
  assert.throws(()=>verifySSHHost(profile,'SHA256:changed',options),/ha cambiado/);assert.equal(prompts,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
