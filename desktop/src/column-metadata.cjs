const {identifier}=require('./adapters/sql-common.cjs');
const q=(name,engine)=>['mysql','mariadb','clickhouse'].includes(engine)?'`'+name.replaceAll('`','``')+'`':identifier(name,engine);
const hex=value=>Buffer.from(value).toString('hex');
async function readColumns(adapter,engine,requests,schemas) {
  if(!Array.isArray(requests)||requests.length>8)throw new Error('Solicita hasta ocho tablas.');
  const result=[];
  for(const request of requests){
    const {schema,name}=request||{};
    if(typeof schema!=='string'||typeof name!=='string'||!schemas.some(item=>item.name===schema&&item.objects.some(object=>object.name===name&&['table','view'].includes(object.type))))throw new Error('La tabla no está en el catálogo visible.');
    let rows=[];
    if(engine==='sqlite')rows=(adapter.database.exec(`PRAGMA main.table_info(${q(name,engine)})`)[0]?.values||[]).map(row=>[row[1],row[2]]);
    else if(['mysql','mariadb'].includes(engine)){const [values]=await adapter.connection.promise().query(`SELECT COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=CONVERT(0x${hex(schema)} USING utf8mb4) AND TABLE_NAME=CONVERT(0x${hex(name)} USING utf8mb4) ORDER BY ORDINAL_POSITION`);rows=values;}
    else if(engine==='postgresql')rows=(await adapter.client.query({text:'SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',values:[schema,name],rowMode:'array'})).rows;
    else if(engine==='oracle')rows=(await adapter.connection.execute('SELECT COLUMN_NAME,DATA_TYPE FROM ALL_TAB_COLUMNS WHERE OWNER=:owner AND TABLE_NAME=:name ORDER BY COLUMN_ID',{owner:schema,name})).rows;
    else if(engine==='sqlserver'){const literal=value=>"N'"+value.replaceAll("'","''")+"'";rows=(await adapter.execute(`SELECT c.name,TYPE_NAME(c.user_type_id) FROM sys.columns c JOIN sys.objects o ON o.object_id=c.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE s.name=${literal(schema)} AND o.name=${literal(name)} ORDER BY c.column_id`)).results[0]?.values||[];}
    else if(engine==='clickhouse')rows=(await(await adapter.client.query({query:'SELECT name,type FROM system.columns WHERE database={schema:String} AND table={table:String} ORDER BY position',query_params:{schema,table:name},format:'JSONCompact'})).json()).data;
    result.push({schema,name,columns:rows.map(([name,dataType])=>({name:String(name),dataType:String(dataType)}))});
  }
  return result;
}
module.exports={readColumns};
