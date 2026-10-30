const fs=require('node:fs/promises'); const path=require('node:path');
class CredentialStore {
 constructor(dir,storage){this.file=path.join(dir,'credentials.json');this.storage=storage;this.pending=Promise.resolve();}
 async read(){try{const v=JSON.parse(await fs.readFile(this.file,'utf8'));if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Almacén de contraseñas no válido.');return v;}catch(e){if(e.code==='ENOENT')return {};throw e;}}
 async has(id){return typeof (await this.read())[id]==='string';}
 async get(id){const v=(await this.read())[id];if(typeof v!=='string')throw Error('No hay contraseña guardada.');try{if(!this.storage.isEncryptionAvailable())throw Error();return this.storage.decryptString(Buffer.from(v,'base64'));}catch{throw Error('No se puede recuperar la contraseña guardada en este equipo o cuenta. Introduce la contraseña de nuevo.');}}
 change(action){const op=this.pending.then(async()=>{const v=await this.read();action(v);await fs.mkdir(path.dirname(this.file),{recursive:true});await fs.writeFile(this.file+'.tmp',JSON.stringify(v),{mode:0o600});await fs.rename(this.file+'.tmp',this.file);});this.pending=op.catch(()=>{});return op;}
 set(id,password){if(!this.storage.isEncryptionAvailable())throw Error('El almacenamiento seguro no está disponible.');const v=this.storage.encryptString(password).toString('base64');return this.change(data=>{data[id]=v;});}
 remove(ids){return this.change(data=>{for(const id of ids)delete data[id];});}
 copy(from,to){return this.change(data=>{if(typeof data[from]==='string')data[to]=data[from];});}
} module.exports={CredentialStore};
