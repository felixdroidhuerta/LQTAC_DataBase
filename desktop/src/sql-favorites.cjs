const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
class SQLFavorites {
  constructor(directory){this.file=path.join(directory,'sql-favorites.json');this.pending=Promise.resolve();}
  async list(){try{const data=JSON.parse(await fs.readFile(this.file,'utf8'));if(!Array.isArray(data)||!data.every(x=>x&&typeof x.id==='string'&&typeof x.name==='string'&&typeof x.sql==='string'))throw Error('El archivo de favoritos no tiene un formato válido.');return data;}catch(error){if(error.code==='ENOENT')return [];throw error;}}
  mutate(action){const op=this.pending.then(async()=>{const values=await this.list(),result=action(values),content=JSON.stringify(values,null,2);if(Buffer.byteLength(content)>16000000)throw Error('La biblioteca de favoritos supera los 16 MB.');await fs.mkdir(path.dirname(this.file),{recursive:true});await fs.writeFile(this.file+'.tmp',content,{mode:0o600});await fs.rename(this.file+'.tmp',this.file);return result;});this.pending=op.catch(()=>{});return op;}
  add(name,sql){return this.mutate(values=>{if(typeof name!=='string'||!name.trim()||name.trim().length>160)throw Error('Escribe un nombre de hasta 160 caracteres.');if(typeof sql!=='string'||!sql.trim()||sql.length>1000000)throw Error('El favorito debe contener SQL y no superar un millón de caracteres.');if(values.length>=1000)throw Error('La biblioteca admite hasta 1.000 favoritos.');const item={id:randomUUID(),name:name.trim(),sql,createdAt:new Date().toISOString()};values.push(item);return item;});}
  remove(id){return this.mutate(values=>{const index=values.findIndex(x=>x.id===id);if(index<0)throw Error('No se encuentra el favorito.');values.splice(index,1);return true;});}
  rename(id,name){return this.mutate(values=>{if(typeof name!=='string'||!name.trim()||name.trim().length>160)throw Error('Escribe un nombre de hasta 160 caracteres.');const item=values.find(x=>x.id===id);if(!item)throw Error('No se encuentra el favorito.');item.name=name.trim();return item;});}
}
module.exports={SQLFavorites};
