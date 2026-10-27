const fs=require('node:fs/promises');const path=require('node:path');const {randomUUID}=require('node:crypto');
function validateText(sql){if(typeof sql!=='string'||sql.length>1000000||sql.includes('\0'))throw new Error('El archivo SQL debe ser texto y tener como máximo un millón de caracteres.');}
function decodeSQL(bytes){
  let encoding='utf-8',bom=false;
  if(bytes[0]===0xff&&bytes[1]===0xfe){encoding='utf-16le';bom=true;}else if(bytes[0]===0xfe&&bytes[1]===0xff){encoding='utf-16be';bom=true;}else bom=bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf;
  let sql;try{sql=new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch{throw new Error('El archivo no es UTF-8 ni UTF-16 con BOM. Guárdalo como UTF-8 e inténtalo de nuevo.');}validateText(sql);return {sql,encoding,bom};
}
function encodeSQL(sql,{encoding='utf-8',bom=false}={}){
  validateText(sql);if(encoding==='utf-8')return Buffer.concat([bom?Buffer.from([0xef,0xbb,0xbf]):Buffer.alloc(0),Buffer.from(sql,'utf8')]);
  const data=Buffer.from(sql,'utf16le');if(encoding==='utf-16be')data.swap16();return Buffer.concat([Buffer.from(encoding==='utf-16be'?[0xfe,0xff]:[0xff,0xfe]),data]);
}
async function atomicWrite(file,data){const temporary=file+'.lqtac-'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,data,{flag:'wx',mode:0o600});await fs.rename(temporary,file);}finally{await fs.unlink(temporary).catch(()=>{});}}
class SQLFiles{
  constructor(directory){this.file=path.join(directory,'sql-file-references.json');this.references=[];this.pending=Promise.resolve();this.ready=this.load();this.ready.catch(()=>{});}
  async load(){try{const items=JSON.parse(await fs.readFile(this.file,'utf8'));if(!Array.isArray(items)||items.some(item=>typeof item.id!=='string'||typeof item.path!=='string'||!path.isAbsolute(item.path)||!['utf-8','utf-16le','utf-16be'].includes(item.encoding)))throw new Error('Referencias de archivos SQL no válidas.');this.references=items.slice(-200);}catch(error){if(error.code!=='ENOENT')throw error;}}
  run(action){const operation=this.pending.then(async()=>{await this.ready;return action();});this.pending=operation.catch(()=>{});return operation;}
  async persist(){await fs.mkdir(path.dirname(this.file),{recursive:true});await atomicWrite(this.file,JSON.stringify(this.references));}
  async reference(file,encoding,bom){let item=this.references.find(item=>item.path===file);if(!item){item={id:randomUUID(),path:file,encoding,bom};this.references.push(item);}else Object.assign(item,{encoding,bom});this.references=this.references.slice(-200);await this.persist();return {id:item.id,name:path.basename(file)};}
  open(file){return this.run(async()=>{const stat=await fs.stat(file);if(!stat.isFile()||stat.size>4000003)throw new Error('Selecciona un archivo SQL de hasta 4 MB.');const decoded=decodeSQL(await fs.readFile(file));return {...await this.reference(file,decoded.encoding,decoded.bom),sql:decoded.sql};});}
  save(request,chooseFile){return this.run(async()=>{validateText(request?.sql);if(request.id!==undefined&&(typeof request.id!=='string'||request.id.length>100))throw new Error('Referencia SQL no válida.');const existing=!request.saveAs&&this.references.find(item=>item.id===request.id);const file=existing?.path||await chooseFile();if(!file)return null;await atomicWrite(file,encodeSQL(request.sql,existing||{}));return this.reference(file,existing?.encoding||'utf-8',existing?.bom||false);});}
}
module.exports={SQLFiles,decodeSQL,encodeSQL};
