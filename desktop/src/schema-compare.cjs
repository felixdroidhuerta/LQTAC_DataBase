const {identifier}=require('./mysql-table.cjs');
const TYPES=['trigger','view','procedure','function'];
async function readDefinitions(adapter,schema,{timeoutSeconds=30,onProgress=()=>{}}={}){
 identifier(schema);let bytes=0;
 const query=async(sql,values=[])=>{
  const [rows,fields]=await adapter.connection.promise().query({sql,values,timeout:timeoutSeconds*1000});
  return rows.map(row=>Object.fromEntries(fields.map((field,index)=>[field.name,row[index]])));
 };
 const mode=(await query('SELECT @@SESSION.sql_mode AS sql_mode'))[0]?.sql_mode||'';
 const lists=await Promise.all([
  query('SELECT TRIGGER_NAME AS name, EVENT_OBJECT_SCHEMA AS table_schema, EVENT_OBJECT_TABLE AS table_name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME',[schema]).then(rows=>rows.map(item=>({name:item.name,type:'trigger',table:item.table_name||null,tableSchema:item.table_schema||schema}))),
  query('SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',[schema]).then(rows=>rows.map(item=>({name:item.name,type:'view'}))),
  query('SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS kind FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME',[schema]).then(rows=>rows.map(item=>({name:item.name,type:String(item.kind).toLowerCase()})))
 ]);
 const objects=lists.flat();if(objects.length>2000)throw Error('La base supera 2.000 objetos visibles. Reduce el alcance antes de comparar.');
 const result=[];
 for(const object of objects){
  if(!TYPES.includes(object.type))continue;identifier(object.name);
  const item={...object,schema,sqlMode:mode,ddl:'',error:null};
  try{
   const [record]=await query(`SHOW CREATE ${object.type.toUpperCase()} ${identifier(schema)}.${identifier(object.name)}`);
   item.ddl=record?.['SQL Original Statement']||record?.['Create '+object.type[0].toUpperCase()+object.type.slice(1)];
   if(typeof item.ddl!=='string'||!item.ddl.trim())throw Error('No tienes permiso para leer la definición completa.');
   item.sqlMode=record.sql_mode??mode;
   bytes+=Buffer.byteLength(item.ddl);if(bytes>24*1024*1024)throw Object.assign(Error('Las definiciones superan 24 MB por base.'),{oversize:true});
  }catch(error){if(error.oversize||adapter.alive===false||error.fatal)throw error;item.ddl='';item.error=error.message;}
  result.push(item);onProgress(result.length,objects.length);
 }
 return {schema,objects:result,loadedAt:new Date().toISOString(),notice:'Solo se incluyen objetos visibles para el usuario. Un objeto no visible por permisos puede parecer ausente.'};
}
module.exports={readDefinitions};
