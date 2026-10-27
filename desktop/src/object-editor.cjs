const {createHash}=require('node:crypto');
const oracle=require('oracledb');
const {identifier:mysqlId,literal:mysqlLiteral}=require('./mysql-table.cjs');
const {identifier}=require('./adapters/sql-common.cjs');
const q=(value,engine)=>['mysql','mariadb','clickhouse'].includes(engine)?mysqlId(value):identifier(value,engine);
const lit=value=>"'"+String(value).replaceAll("'","''")+"'";
function tokens(source,engine,mode=''){
  const result=[];let i=0;
  while(i<source.length){const start=i,c=source[i];if(/\s/.test(c)){i++;continue;}
    if(source.startsWith('--',i)||(c==='#'&&['mysql','mariadb'].includes(engine))){const end=source.indexOf('\n',i);i=end<0?source.length:end;continue;}
    if(source.startsWith('/*',i)){const end=source.indexOf('*/',i+2);if(end<0)throw new Error('Comentario sin cerrar.');i=end+2;continue;}
    const dollar=engine==='postgresql'&&c==='$'?/^\$(?:[a-zA-Z_]\w*)?\$/.exec(source.slice(i))?.[0]:null;
    if(dollar){const end=source.indexOf(dollar,i+dollar.length);if(end<0)throw new Error('Cuerpo dollar-quoted sin cerrar.');i=end+dollar.length;result.push({kind:'string',value:source.slice(start,i),start,end:i});continue;}
    const alternative=engine==='oracle'?/^q'([\s\S])/i.exec(source.slice(i)):null;
    if(alternative){const close={'[':']','{':'}','(':')','<':'>'}[alternative[1]]||alternative[1];const end=source.indexOf(close+"'",i+3);if(end<0)throw new Error('Cadena Oracle sin cerrar.');i=end+2;result.push({kind:'string',value:source.slice(start,i),start,end:i});continue;}
    if(["'",'"','`'].includes(c)||(c==='['&&engine==='sqlserver')){const close=c==='['?']':c;let value='',closed=false;i++;
      while(i<source.length){if(source[i]==='\\'&&['mysql','mariadb'].includes(engine)&&!mode.includes('NO_BACKSLASH_ESCAPES')){value+=source[i+1]||'';i+=2;continue;}if(source[i]===close){if(source[i+1]===close){value+=close;i+=2;continue;}i++;closed=true;break;}value+=source[i++];}if(!closed)throw new Error('Cadena o identificador sin cerrar.');result.push({kind:c==="'"?'string':'quoted',value,start,end:i});continue;}
    const word=/^[\p{L}\p{N}_$#]+/u.exec(source.slice(i));if(word){i+=word[0].length;result.push({kind:'word',value:word[0],start,end:i});}else{result.push({kind:c,value:c,start,end:++i});}
  }
  return result;
}
function header(source,target){
  const list=tokens(source,target.engine,target.sqlMode);const first=list[0]?.value.toUpperCase();if(!['CREATE','ALTER'].includes(first))throw new Error('La definición debe comenzar con CREATE o ALTER.');
  const index=list.findIndex((token,i)=>i>0&&i<30&&token.kind==='word'&&['VIEW','PROCEDURE','PROC','FUNCTION'].includes(token.value.toUpperCase()));if(index<0||list.slice(0,index).some(token=>token.kind===';'))throw new Error('No se reconoce la definición del objeto.');
  const kind=list[index].value.toUpperCase()==='PROC'?'procedure':list[index].value.toLowerCase();if(kind!==target.type)throw new Error('No puedes cambiar el tipo del objeto desde este editor.');
  if(list.slice(0,index).some(token=>token.value.toUpperCase()==='MATERIALIZED'))throw new Error('La edición de vistas materializadas requiere instrucciones específicas del motor.');
  let next=index+1;const parts=[];
  for(let count=0;count<2;count++){const token=list[next];if(!token||!['word','quoted'].includes(token.kind))throw new Error('Nombre del objeto no válido.');let value=token.value;if(token.kind==='word'&&target.engine==='postgresql')value=value.toLowerCase();if(token.kind==='word'&&target.engine==='oracle')value=value.toUpperCase();parts.push(value);next++;if(list[next]?.kind!=='.')break;if(count===1)throw new Error('Usa nombre de esquema y objeto, sin cambiar de base.');next++;}
  if(parts.at(-1)!==target.name||(parts.length===2&&parts[0]!==target.schema))throw new Error('La definición debe conservar el esquema y nombre originales.');
  let prefixEnd=list[0].end;if(list[1]?.value.toUpperCase()==='OR'&&['REPLACE','ALTER'].includes(list[2]?.value.toUpperCase()))prefixEnd=list[2].end;
  let definer=null;const def=list.findIndex((token,i)=>i<index&&token.kind==='word'&&token.value.toUpperCase()==='DEFINER');if(def>=0){if(list[def+1]?.kind!=='='||!list[def+2]||list[def+3]?.kind!=='@'||!list[def+4])throw new Error('Definer no válido.');definer=list[def+2].value+'@'+list[def+4].value;}
  // Only view DDL is a plain SQL statement; stored bodies legitimately contain semicolons.
  if(kind==='view'&&list.some((token,i)=>token.kind===';'&&i!==list.length-1))throw new Error('Revisa una sola definición de vista, sin sentencias adicionales.');
  if(['mysql','mariadb'].includes(target.engine)&&/^\s*DELIMITER\b/im.test(source))throw new Error('No uses DELIMITER: se envía una definición completa al controlador.');
  let signature='';if(list[next]?.kind==='('){let depth=0;const values=[];for(let i=next;i<list.length;i++){const token=list[i];if(token.kind==='(')depth++;if(token.kind===')')depth--;values.push([token.kind,token.kind==='word'?token.value.toLowerCase():token.value]);if(!depth)break;}signature=JSON.stringify(values);}
  return {list,index,nameStart:list[index+1].start,nameEnd:list[next-1].end,prefixEnd,definer,signature};
}
function normalizeDDL(source,target,verb){
  const parsed=header(source,target);const qualified=q(target.schema,target.engine)+'.'+q(target.name,target.engine);
  return source.slice(0,parsed.list[0].start)+verb+source.slice(parsed.prefixEnd,parsed.nameStart)+qualified+source.slice(parsed.nameEnd);
}
function fingerprint(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
async function inspectObject(adapter,engine,target){
  const {schema,name,type}=target;if(!['view','procedure','function'].includes(type))throw new Error('Tipo de objeto no válido.');const original={schema,name,type,engine,oid:target.oid||null};let ddl;
  if(['mysql','mariadb'].includes(engine)){
    const [rows,fields]=await adapter.connection.promise().query(`SHOW CREATE ${type.toUpperCase()} ${q(schema,engine)}.${q(name,engine)}`);if(!rows[0])throw new Error('El objeto no existe.');const record=Object.fromEntries(fields.map((field,i)=>[field.name,rows[0][i]]));ddl=record['Create '+type[0].toUpperCase()+type.slice(1)];if(!ddl)throw new Error('No tienes permisos para leer la definición completa.');
    const [settings]=await adapter.connection.promise().query('SELECT @@SESSION.sql_mode AS sql_mode');original.sqlMode=record.sql_mode??settings[0][0];original.collation=record.collation_connection||'';original.definer=header(ddl,original).definer;
  }else if(engine==='sqlite'){
    if(type!=='view')throw new Error('SQLite no tiene procedimientos ni funciones almacenadas editables.');const statement=adapter.database.prepare('SELECT sql FROM sqlite_master WHERE type=\'view\' AND name=?');try{statement.bind([name]);if(statement.step())ddl=statement.get()[0];}finally{statement.free();}
  }else if(engine==='postgresql'){
    await adapter.currentDatabase();original.databaseName=adapter.databaseName;original.searchPath=(await adapter.client.query('SHOW search_path')).rows[0].search_path;
    if(type==='view'){
      const {rows}=await adapter.client.query('SELECT pg_get_viewdef(c.oid,true) AS definition,c.reloptions AS options FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind=\'v\'',[schema,name]);const view=rows[0];if(view){const options=view.options||[];ddl=`CREATE OR REPLACE VIEW ${q(schema,engine)}.${q(name,engine)}${options.length?' WITH ('+options.join(', ')+')':''} AS\n${view.definition}`;}
    }else{
      if(!/^\d+$/.test(String(target.oid||'')))throw new Error('Recarga el catálogo para identificar la firma exacta de esta rutina.');const {rows}=await adapter.client.query('SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=$1::oid AND n.nspname=$2 AND p.proname=$3 AND p.prokind=$4',[target.oid,schema,name,type==='procedure'?'p':'f']);ddl=rows[0]?.definition;
    }
  }else if(engine==='sqlserver'){
    await adapter.currentDatabase();original.databaseName=adapter.databaseName;
    const full=q(schema,engine)+'.'+q(name,engine);const rows=(await adapter.execute(`SELECT m.definition,m.uses_ansi_nulls,m.uses_quoted_identifier FROM sys.sql_modules m WHERE m.object_id=OBJECT_ID(N${lit(full)})`)).results[0]?.values||[];ddl=rows[0]?.[0];original.ansiNulls=!!rows[0]?.[1];original.quotedIdentifier=!!rows[0]?.[2];
  }else if(engine==='oracle'){
    const result=await adapter.connection.execute('SELECT DBMS_METADATA.GET_DDL(:kind,:name,:owner) AS DDL FROM DUAL',{kind:type.toUpperCase(),name,owner:schema},{fetchInfo:{DDL:{type:oracle.STRING}}});ddl=result.rows[0]?.[0];
  }else if(engine==='clickhouse'){
    if(type!=='view')throw new Error('Este editor de ClickHouse admite vistas SQL normales.');const result=await(await adapter.client.query({query:`SHOW CREATE TABLE ${q(schema,engine)}.${q(name,engine)}`,format:'JSONCompact'})).json();ddl=result.data[0]?.[0];
  }else if(engine==='mongodb'){
    if(type!=='view')throw new Error('MongoDB no tiene rutinas SQL editables.');const view=(await adapter.client.db(schema).listCollections({name},{nameOnly:false}).toArray())[0];if(view?.type==='view')ddl=JSON.stringify({viewOn:view.options.viewOn,pipeline:view.options.pipeline||[]},null,2);
  }
  if(typeof ddl!=='string'||!ddl.trim())throw new Error('La definición no está disponible o está cifrada; revisa los permisos del usuario.');
  if(engine!=='mongodb')ddl=normalizeDDL(ddl,original,'CREATE');original.ddl=ddl;original.version=fingerprint(original);return original;
}
function buildObjectPlan(original,source){
  if(typeof source!=='string'||!source.trim()||source.length>1000000)throw new Error('Escribe una definición de hasta 1 MB.');
  if(original.engine==='mongodb'){const value=JSON.parse(source);if(!value||typeof value.viewOn!=='string'||!value.viewOn||!Array.isArray(value.pipeline)||Object.keys(value).some(key=>!['viewOn','pipeline'].includes(key)))throw new Error('La vista requiere viewOn y pipeline, sin atributos adicionales.');return {sql:JSON.stringify({collMod:original.name,...value},null,2),create:source,mongo:value,warnings:['Se modifica la vista existente mediante collMod.']};}
  const parsed=header(source,original),old=header(original.ddl,original);
  if(['mysql','mariadb'].includes(original.engine)&&parsed.definer!==old.definer)throw new Error('Conserva el DEFINER original para no cambiar la cuenta de ejecución.');
  if(original.engine==='postgresql'&&original.type!=='view'&&parsed.signature!==old.signature)throw new Error('Conserva la firma original. Cambiar parámetros puede crear otra sobrecarga; usa una consulta independiente para ese cambio.');
  // PostgreSQL routine bodies must be quoted, so no additional statement can follow the definition.
  if(original.engine==='postgresql'&&parsed.list.some((token,i)=>token.kind===';'&&i!==parsed.list.length-1))throw new Error('Usa un cuerpo de rutina dollar-quoted y una sola definición.');
  const recreate=['mysql','mariadb'].includes(original.engine)&&original.type!=='view'||original.engine==='sqlite';
  const verb=original.engine==='sqlserver'?'ALTER':recreate?'CREATE':'CREATE OR REPLACE';
  const create=normalizeDDL(source,original,verb);const drop=`DROP ${original.type.toUpperCase()} ${q(original.schema,original.engine)}.${q(original.name,original.engine)}`;
  const warnings=recreate&&original.engine!=='sqlite'?['Cambiar el cuerpo requiere DROP + CREATE: hay un intervalo sin rutina y no es atómico.','Se copian definición y permisos específicos legibles; permisos no visibles podrían perderse. Si falla CREATE, se intentará restaurar la definición original.']:original.engine==='sqlite'?['La vista se reemplaza dentro de un SAVEPOINT de la copia local.']:['Se reemplaza o altera la definición existente. El motor exige permisos DDL y puede invalidar objetos dependientes.'];
  return {sql:recreate?drop+';\n\n'+create:create,create,drop:recreate?drop:null,warnings};
}
async function routineGrants(adapter,original){
  try{const [rows]=await adapter.connection.promise().query(`SELECT User,Host,Proc_priv FROM mysql.procs_priv WHERE Db=CONVERT(0x${Buffer.from(original.schema).toString('hex')} USING utf8mb4) AND Routine_name=CONVERT(0x${Buffer.from(original.name).toString('hex')} USING utf8mb4) AND Routine_type=${lit(original.type.toUpperCase())}`);return rows.map(([user,host,priv])=>{const parts=String(priv).toLowerCase().split(',');const rights=[parts.includes('execute')?'EXECUTE':null,parts.includes('alter routine')?'ALTER ROUTINE':null].filter(Boolean);return rights.length?`GRANT ${rights.join(', ')} ON ${original.type.toUpperCase()} ${q(original.schema,original.engine)}.${q(original.name,original.engine)} TO ${mysqlLiteral(user,original.sqlMode)}@${mysqlLiteral(host,original.sqlMode)}${parts.includes('grant')?' WITH GRANT OPTION':''}`:null;}).filter(Boolean);}catch{return null;}
}
async function applyObject(adapter,original,plan){
  if(original.engine==='mongodb'){await adapter.client.db(original.schema).command({collMod:original.name,...plan.mongo});return {applied:true};}
  if(original.engine==='sqlite'){
    adapter.database.run('SAVEPOINT lqtac_edit_view');try{adapter.database.run(plan.drop);adapter.database.run(plan.create);adapter.database.run('RELEASE lqtac_edit_view');return {applied:true};}catch(error){adapter.database.run('ROLLBACK TO lqtac_edit_view');adapter.database.run('RELEASE lqtac_edit_view');throw error;}
  }
  if(plan.drop){
    await adapter.execute(plan.drop);
    try{await adapter.execute(plan.create);}catch(error){if(!adapter.alive)return {applied:false,uncertain:true,error:'Se perdió la conexión tras DROP; comprueba la rutina antes de reintentar. '+error.message};try{await adapter.execute(original.ddl);for(const grant of plan.grants||[])await adapter.execute(grant);return {applied:false,restored:true,error:'No se aplicó el cambio; se restauró la definición original. '+error.message};}catch(restore){return {applied:false,restored:false,error:'No se pudo restaurar automáticamente la rutina. '+error.message+' Restauración: '+restore.message};}}
    try{for(const grant of plan.grants||[])await adapter.execute(grant);}catch(error){return {applied:true,warning:'Definición aplicada; revisa los permisos específicos: '+error.message};}
    return {applied:true,warning:plan.grants===null?'No se pudieron leer los permisos específicos de otras cuentas. Revisa los permisos de la rutina.':undefined};
  }
  await adapter.execute(plan.create);
  if(original.engine==='oracle'){const errors=await adapter.connection.execute('SELECT LINE,POSITION,TEXT FROM ALL_ERRORS WHERE OWNER=:owner AND NAME=:name AND TYPE=:kind ORDER BY SEQUENCE',{owner:original.schema,name:original.name,kind:original.type.toUpperCase()});if(errors.rows.length)return {applied:true,warning:'Definición guardada con errores de compilación:\n'+errors.rows.map(row=>row.join(': ')).join('\n')};}
  return {applied:true};
}
module.exports={tokens,header,normalizeDDL,inspectObject,buildObjectPlan,routineGrants,applyObject};
