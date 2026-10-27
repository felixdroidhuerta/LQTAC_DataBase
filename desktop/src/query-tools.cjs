const { format } = require('sql-formatter');
const ExcelJS = require('exceljs');
const { identifier } = require('./adapters/sql-common.cjs');

function formatQuery(source, engine) {
  if (typeof source !== 'string' || !source.trim() || source.length > 250000) throw new Error('Selecciona o escribe una consulta de hasta 250.000 caracteres.');
  if (engine === 'mongodb') return JSON.stringify(JSON.parse(source), null, 2);
  const language = { mysql:'mysql',mariadb:'mariadb',postgresql:'postgresql',sqlserver:'transactsql',oracle:'plsql',sqlite:'sqlite',clickhouse:'sql' }[engine];
  if (!language) throw new Error('Motor no válido.');
  return format(source,{language,tabWidth:2,keywordCase:'preserve'});
}
function visibleResults(output, limit = 1000) {
  if (![0,50,100,500,1000].includes(limit)) throw new Error('Selecciona un límite válido.');
  return { ...output, results: output.results.map(result=>({...result, values:limit === 0 ? result.values : result.values.slice(0,limit),truncated:result.truncated || (limit !== 0 && result.values.length>limit)})),displayLimit:limit };
}
function csvField(value) {
  let text=value==null?'':String(value);
  // Text that Excel could interpret as a formula remains plain text on CSV import.
  if(typeof value==='string' && /^[\s\uFEFF]*[=+\-@\t\r]/.test(text)) text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}
function exportRows(result,indices){
  if(indices===undefined)return result;
  if(!Array.isArray(indices)||indices.length>result.values.length||new Set(indices).size!==indices.length||indices.some(index=>!Number.isInteger(index)||index<0||index>=result.values.length))throw new Error('La selección de filas para exportar no es válida.');
  return {...result,values:indices.map(index=>result.values[index])};
}
async function exportResult(result, format) {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.values)) throw new Error('No hay resultados para exportar.');
  if (format==='csv') return Buffer.from('\uFEFF'+[result.columns,...result.values].map(row=>row.map(csvField).join(',')).join('\r\n')+'\r\n','utf8');
  if (format!=='xlsx') throw new Error('Formato no válido.');
  if (result.columns.length>16384) throw new Error('El resultado supera el límite de columnas de XLSX.');
  if([result.columns,...result.values].some(row=>row.some(value=>typeof value==='string'&&value.length>32767)))throw new Error('Una celda supera los 32.767 caracteres de XLSX. Exporta a CSV para conservarla completa.');
  const workbook=new ExcelJS.Workbook(); const sheet=workbook.addWorksheet('Resultados');
  sheet.addRow(result.columns.map(String));
  for(const row of result.values) sheet.addRow(row.map(value=>value==null?null:typeof value==='number'||typeof value==='boolean'?value:String(value)));
  sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF146FA5'}};
  sheet.views=[{state:'frozen',ySplit:1}]; sheet.columns.forEach(column=>{column.width=24;});
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
function relationGraph(rows,nodes,warning) {
  const byNode=new Map(nodes.map(node=>[JSON.stringify([node.schema,node.name]),node]));const edges=new Map();
  for(const [name,fromSchema,fromTable,fromColumn,toSchema,toTable,toColumn] of rows) {
    if(!fromTable || !toTable) continue;
    const from=JSON.stringify([fromSchema,fromTable]),to=JSON.stringify([toSchema,toTable]);
    byNode.set(from,{schema:fromSchema,name:fromTable});byNode.set(to,{schema:toSchema,name:toTable});
    const key=JSON.stringify([from,name,to]);if(!edges.has(key))edges.set(key,{name,from,to,columns:[]});edges.get(key).columns.push({from:fromColumn,to:toColumn});
  }
  return {nodes:[...byNode].map(([id,node])=>({id,...node})),edges:[...edges.values()],warning};
}
async function readRelations(adapter,engine,schema,schemas) {
  const nodes=(schemas.find(item=>item.name===schema)?.objects||[]).filter(item=>item.type==='table').map(item=>({schema,name:item.name}));
  if(['mongodb','clickhouse'].includes(engine)) return relationGraph([],nodes,'Este motor no expone claves foráneas relacionales compatibles. No se deducen relaciones por nombres de columnas.');
  if(engine==='sqlite') {
    const rows=[];
    for(const node of nodes) for(const [id,seq,target,from,to] of adapter.database.exec('PRAGMA main.foreign_key_list('+identifier(node.name)+')')[0]?.values||[]) rows.push([`fk_${node.name}_${id}`,schema,node.name,from,schema,target,to||'(PK)']);
    return relationGraph(rows,nodes);
  }
  const literal="'"+schema.replaceAll("'","''")+"'";
  const queries={
    mysql:`SELECT CONSTRAINT_NAME,TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=CONVERT(0x${Buffer.from(schema).toString('hex')} USING utf8mb4) AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`,
    postgresql:`SELECT c.conname,n.nspname,t.relname,a.attname,rn.nspname,rt.relname,ra.attname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class rt ON rt.oid=c.confrelid JOIN pg_namespace rn ON rn.oid=rt.relnamespace CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY k(src,dst,ord) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.src JOIN pg_attribute ra ON ra.attrelid=rt.oid AND ra.attnum=k.dst WHERE c.contype='f' AND n.nspname=convert_from(decode('${Buffer.from(schema).toString('hex')}','hex'),'UTF8') ORDER BY t.relname,c.conname,k.ord`,
    sqlserver:`SELECT fk.name,s.name,t.name,c.name,rs.name,rt.name,rc.name FROM sys.foreign_keys fk JOIN sys.foreign_key_columns k ON k.constraint_object_id=fk.object_id JOIN sys.tables t ON t.object_id=k.parent_object_id JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.columns c ON c.object_id=t.object_id AND c.column_id=k.parent_column_id JOIN sys.tables rt ON rt.object_id=k.referenced_object_id JOIN sys.schemas rs ON rs.schema_id=rt.schema_id JOIN sys.columns rc ON rc.object_id=rt.object_id AND rc.column_id=k.referenced_column_id WHERE s.name=N${literal} ORDER BY t.name,fk.name,k.constraint_column_id`,
    oracle:`SELECT c.CONSTRAINT_NAME,c.OWNER,c.TABLE_NAME,k.COLUMN_NAME,r.OWNER,r.TABLE_NAME,rk.COLUMN_NAME FROM ALL_CONSTRAINTS c JOIN ALL_CONS_COLUMNS k ON k.OWNER=c.OWNER AND k.CONSTRAINT_NAME=c.CONSTRAINT_NAME JOIN ALL_CONSTRAINTS r ON r.OWNER=c.R_OWNER AND r.CONSTRAINT_NAME=c.R_CONSTRAINT_NAME JOIN ALL_CONS_COLUMNS rk ON rk.OWNER=r.OWNER AND rk.CONSTRAINT_NAME=r.CONSTRAINT_NAME AND rk.POSITION=k.POSITION WHERE c.CONSTRAINT_TYPE='R' AND c.OWNER=${literal} ORDER BY c.TABLE_NAME,c.CONSTRAINT_NAME,k.POSITION`
  };
  const output=await adapter.execute(queries[engine==='mariadb'?'mysql':engine]);const result=output.results[0];
  return relationGraph(result?.values||[],nodes,result?.truncated?'El catálogo de relaciones está limitado a 1.000 columnas de claves foráneas.':undefined);
}
module.exports={formatQuery,visibleResults,csvField,exportResult,exportRows,relationGraph,readRelations};
