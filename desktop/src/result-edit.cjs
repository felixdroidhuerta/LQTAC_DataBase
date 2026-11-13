const {randomUUID,createHash}=require('node:crypto');
const {identifier,cell}=require('./adapters/sql-common.cjs');
const quote=(name,engine)=>['mysql','mariadb'].includes(engine)?'`'+name.replaceAll('`','``')+'`':identifier(name,engine);
const literal=value=>value===null?'NULL':value===''?"''":`CONVERT(0x${Buffer.from(String(value),'utf8').toString('hex')} USING utf8mb4)`;
const resultCell=value=>value instanceof Uint8Array?`[BLOB ${value.length} bytes]`:cell(value);
const previewLiteral=value=>value===null?'NULL':typeof value==='number'?String(value):"'"+String(value).replaceAll("'","''")+"'";
function targetFromSQL(sql,engine,database){
  if(!['sqlite','mysql','mariadb','postgresql'].includes(engine)||typeof sql!=='string')return null;
  const tokens=[];let i=0;
  while(i<sql.length){
    const c=sql[i];if(/\s/.test(c)){i++;continue;}
    if(sql.startsWith('--',i)||(['mysql','mariadb'].includes(engine)&&c==='#')){const end=sql.indexOf('\n',i+2);i=end<0?sql.length:end+1;continue;}
    if(sql.startsWith('/*',i)){const end=sql.indexOf('*/',i+2);if(end<0)return null;i=end+2;continue;}
    if(['`','"',"'",'['].includes(c)){const close=c==='['?']':c;let value='',end=false;i++;while(i<sql.length){if(sql[i]===close){if(sql[i+1]===close){value+=close;i+=2;}else{i++;end=true;break;}}else if(sql[i]==='\\'&&c==="'"){value+=sql.slice(i,i+2);i+=2;}else value+=sql[i++];}if(!end)return null;tokens.push({value,word:c!=="'",quoted:true});continue;}
    const word=/^[\p{L}\p{N}_$]+/u.exec(sql.slice(i));if(word){tokens.push({value:word[0],word:true});i+=word[0].length;}else{tokens.push({value:c,word:false});i++;}
  }
  const keyword=(n,value)=>tokens[n]?.word&&!tokens[n].quoted&&tokens[n].value.toUpperCase()===value;
  if(!keyword(0,'SELECT')||tokens[1]?.value!=='*'||!keyword(2,'FROM')||!tokens[3]?.word)return null;
  let schema=database,table=tokens[3].value,next=4;
  if(tokens[next]?.value==='.'){if(!tokens[next+1]?.word)return null;schema=table;table=tokens[next+1].value;next+=2;}
  const clauses=new Set(['WHERE','ORDER','LIMIT','OFFSET','FETCH']);
  if(keyword(next,'AS'))next+=2;
  else if(tokens[next]?.word&&!clauses.has(tokens[next].value.toUpperCase()))next++;
  if(tokens[next]&&tokens[next].value!==';'&&!clauses.has(tokens[next].value.toUpperCase()))return null;
  if(tokens.slice(next).some(t=>t.word&&!t.quoted&&['SELECT','JOIN','UNION','INTERSECT','EXCEPT','INTO','FROM','FOR','GROUP','HAVING'].includes(t.value.toUpperCase())))return null;
  if(tokens.some((t,n)=>t.value===';'&&n!==tokens.length-1))return null;
  if(!schema||!table)return null;
  return {schema,table,qualified:tokens[4]?.value==='.'};
}
function decorateResult(result,{sql,engine,database,adapter,scopeKnown=true}){
  const target=targetFromSQL(sql,engine,database);if(!target)return result;
  if(result.origin){if(result.origin.table!==target.table)return result;target.schema=result.origin.schema;}
  else if(!scopeKnown&&!target.qualified)return result;
  if(engine==='sqlite'&&!target.qualified){
    const temp=adapter.database.exec('SELECT name FROM temp.sqlite_master WHERE type IN (\'table\',\'view\') AND name='+"'"+target.table.replaceAll("'","''")+"'")[0];if(temp?.values.length)target.schema='temp';
  }
  result.editContext={...target,engine,...(result.originOid?{oid:result.originOid}:{})};return result;
}
async function describe(adapter,engine,target,signal){
  signal?.throwIfAborted();
  const {schema,table}=target;let columns=[];
  if(engine==='sqlite'){
    const type=adapter.database.exec(`SELECT type FROM ${quote(schema,engine)}.sqlite_master WHERE name='${table.replaceAll("'","''")}'`)[0]?.values[0]?.[0];if(type!=='table')throw new Error('Solo se editan tablas, no vistas.');
    columns=(adapter.database.exec(`PRAGMA ${quote(schema,engine)}.table_xinfo(${quote(table,engine)})`)[0]?.values||[]).map(row=>({name:row[1],type:row[2],primary:Number(row[5])>0,nullable:!row[3],generated:Number(row[6])!==0,defaultValue:row[4]}));
    if(columns.filter(c=>c.primary).length===1){const pk=columns.find(c=>c.primary);if(/^integer$/i.test(pk.type))pk.auto=true;}
  }else if(['mysql','mariadb'].includes(engine)){
    const qualified=quote(schema,engine)+'.'+quote(table,engine);
    const [,definitionFields]=await adapter.connection.promise().query('SHOW CREATE TABLE '+qualified);signal?.throwIfAborted();if(!definitionFields?.some(f=>f.name==='Create Table'))throw new Error('Solo se editan tablas, no vistas.');
    const records=async sql=>{signal?.throwIfAborted();const [rows,fields]=await adapter.connection.promise().query(sql);signal?.throwIfAborted();return rows.map(row=>Object.fromEntries(fields.map((field,i)=>[field.name,row[i]])));};
    const indexes=await records('SHOW INDEX FROM '+qualified),keys=new Set(indexes.filter(row=>row.Key_name==='PRIMARY').map(row=>row.Column_name));
    const rows=await records('SHOW FULL COLUMNS FROM '+qualified);
    columns=rows.map(row=>({name:row.Field,type:row.Type,primary:keys.has(row.Field),nullable:row.Null==='YES',generated:/(?:VIRTUAL|STORED) GENERATED/i.test(row.Extra||''),auto:/auto_increment/i.test(row.Extra||''),defaultValue:row.Default}));
  }else if(engine==='postgresql'){
    const {rows}=await adapter.client.query({text:`SELECT c.oid::text,a.attname,format_type(a.atttypid,a.atttypmod),EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)),NOT a.attnotnull,COALESCE(to_jsonb(a)->>'attgenerated',''),COALESCE(to_jsonb(a)->>'attidentity',''),pg_get_expr(d.adbin,d.adrelid) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p') AND (c.relkind='p' OR NOT EXISTS(SELECT 1 FROM pg_inherits inh WHERE inh.inhparent=c.oid)) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,values:[schema,table],rowMode:'array'});
    if(target.oid&&rows[0]?.[0]!==String(target.oid))throw new Error('El origen del resultado ya no corresponde a esta tabla.');
    columns=rows.map(([,name,type,primary,nullable,generated,identity,defaultValue])=>({name,type,primary,nullable,generated:!!generated,auto:!!identity||/^nextval\(/i.test(defaultValue||''),defaultValue:defaultValue??null}));
  }else throw new Error('La edición de datos de este motor no está disponible.');
  signal?.throwIfAborted();
  if(!columns.length||!columns.some(c=>c.primary))throw new Error('La tabla necesita una clave primaria para identificar cada registro.');
  return {columns,fingerprint:createHash('sha256').update(JSON.stringify(columns)).digest('hex')};
}
function normalize(value,column,engine){
  if(value===null){if(!column.nullable)throw new Error(`${column.name} no admite NULL.`);return null;}
  if(typeof value!=='string'||value.length>1000000)throw new Error('El valor de la celda no es válido.');
  const type=column.type.toLowerCase();
  if(/^(?:tinyint|smallint|mediumint|int|integer|bigint|smallserial|serial|bigserial)\b/.test(type)){
    if(!/^[+-]?\d+$/.test(value.trim()))throw new Error(`${column.name} requiere un entero.`);
    const number=BigInt(value.trim());const bits=/tinyint/.test(type)?8:/smallint|smallserial/.test(type)?16:/mediumint/.test(type)?24:/bigint|bigserial/.test(type)?64:32;const unsigned=/unsigned/.test(type);const min=unsigned?0n:-(1n<<BigInt(bits-1)),max=(1n<<BigInt(unsigned?bits:bits-1))-1n;
    if(engine!=='sqlite'&&(number<min||number>max))throw new Error(`${column.name} está fuera del rango permitido.`);
    if(engine==='sqlite'){const parsed=Number(number);if(!Number.isSafeInteger(parsed))throw new Error('SQLite: el entero supera la precisión disponible en esta cuadrícula.');return parsed;}
    return value.trim();
  }
  if(/^(?:decimal|numeric|real|float|double)\b/.test(type)){
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))throw new Error(`${column.name} requiere un número.`);
    if(engine==='sqlite'){const number=Number(value);if(!Number.isFinite(number))throw new Error('Número no válido.');return number;}
  }
  return value;
}
class ResultEdits {
  constructor(){this.sessions=new Map();}
  async open(snapshot,index,adapter,engine,key,signal){
    const result=snapshot?.results?.[index];if(!result?.editContext)throw new Error('Abre los datos de una única tabla con SELECT * para editarlos.');
    const target=result.editContext;const metadata=await describe(adapter,engine,target,signal);
    const columns=result.columns.map(name=>metadata.columns.find(column=>column.name===name));
    if(columns.some(c=>!c)||new Set(result.columns).size!==result.columns.length||metadata.columns.some(c=>c.primary&&!result.columns.includes(c.name)))throw new Error('El resultado debe incluir los campos y la clave primaria de una única tabla.');
    const unsupported=c=>/blob|binary|bytea|json|xml|interval|geometry|geography|point|polygon|array|\[\]/i.test(c.type);
    columns.forEach(c=>{c.insertable=!c.generated&&!unsupported(c);c.editable=!c.primary&&c.insertable;});
    const primary=columns.map((c,i)=>c.primary?i:-1).filter(i=>i>=0);const seen=new Set();
    for(const row of result.values){const identity=primary.map(i=>row[i]);if(identity.some(v=>v===null||v===undefined||typeof v==='number'&&!Number.isSafeInteger(v)))throw new Error('La clave de una fila no se puede representar con seguridad.');const id=JSON.stringify(identity);if(seen.has(id))throw new Error('Hay claves duplicadas en este resultado.');seen.add(id);}
    const token=randomUUID();for(const [id,item]of this.sessions)if(item.expires<Date.now()||(item.snapshot===snapshot&&item.index===index))this.sessions.delete(id);
    this.sessions.set(token,{snapshot,index,adapter,engine,key,target,columns,primary,metadata:metadata.fingerprint,rows:structuredClone(result.values),expires:Date.now()+1800000});
    return {token,target:`${target.schema}.${target.table}`,columns:columns.map(c=>({name:c.name,type:c.type,editable:c.editable,insertable:c.insertable,nullable:c.nullable,primary:c.primary,auto:!!c.auto,hasDefault:c.defaultValue!=null}))};
  }
  async apply(request,snapshot,adapter,key,execute,onProgress=()=>{},readMetadata=read=>read()){
    const item=this.sessions.get(request?.token);
    if(!item||item.snapshot!==snapshot||item.adapter!==adapter||item.key!==key||item.expires<Date.now())throw new Error('El resultado ha caducado o cambió su conexión. Vuelve a consultar la tabla.');
    const changesInput=request.changes||[],deletes=request.deletes||[],inserts=request.inserts||[];
    if(!Array.isArray(changesInput)||!Array.isArray(deletes)||!Array.isArray(inserts)||changesInput.length+deletes.length+inserts.length<1||changesInput.length+deletes.length+inserts.length>10000||Buffer.byteLength(JSON.stringify({changesInput,deletes,inserts}))>8000000)throw new Error('La edición supera el límite permitido.');
    if((await readMetadata(signal=>describe(adapter,item.engine,item.target,signal))).fingerprint!==item.metadata)throw new Error('Cambió la estructura de la tabla. Vuelve a consultarla.');
    const groups=new Map();const cells=new Set();
    for(const change of changesInput){const {row,column,value}=change||{};if(!Number.isInteger(row)||!item.rows[row]||!Number.isInteger(column)||!item.columns[column]?.editable)throw new Error('Celda no editable.');const id=`${row}:${column}`;if(cells.has(id))throw new Error('Hay cambios duplicados.');cells.add(id);if(!groups.has(row))groups.set(row,[]);groups.get(row).push({column,value:normalize(value,item.columns[column],item.engine)});}
    if(new Set(deletes).size!==deletes.length||deletes.some(row=>!Number.isInteger(row)||!item.rows[row]||groups.has(row)))throw new Error('Las filas a borrar no son válidas.');
    if(deletes.length&&item.columns.some(c=>!c.insertable&&!c.generated&&!c.primary))throw new Error('Esta tabla contiene campos cuyo contenido no se puede verificar con seguridad antes de borrar. Usa una consulta SQL para borrar esas filas.');
    const insertRows=[],insertIds=new Set();
    for(const insert of inserts){if(!insert||!Number.isInteger(insert.row)||insert.row<item.rows.length||insertIds.has(insert.row)||!Array.isArray(insert.values))throw new Error('La fila nueva no es válida.');insertIds.add(insert.row);const seen=new Set(),values=[];for(const entry of insert.values){if(!Number.isInteger(entry.column)||!item.columns[entry.column]?.insertable||seen.has(entry.column))throw new Error('Campo no válido en la fila nueva.');seen.add(entry.column);values.push({column:entry.column,value:normalize(entry.value,item.columns[entry.column],item.engine)});}for(const i of item.primary)if(!seen.has(i)&&!item.columns[i].auto&&(item.columns[i].defaultValue==null||['mysql','mariadb'].includes(item.engine)))throw new Error(`Indica la clave ${item.columns[i].name} para la fila nueva.`);insertRows.push({row:insert.row,values});}
    const applied=[],deleted=[],inserted=[];let error,requiresReload=false,completed=0;const total=groups.size+deletes.length+inserts.length;
    const progress=()=>onProgress({completed:++completed,total});onProgress({completed:0,total});
    for(const [row,changes]of groups){
      try{
        const values=await execute(item,()=>this.write(item,row,changes));
        if(!values)throw new Error(`Conflicto en la fila ${row+1}: fue modificada o eliminada. Vuelve a consultar.`);
        item.rows[row]=structuredClone(values);snapshot.results[item.index].values[row]=values;applied.push({row,values});progress();
      }catch(problem){error=problem.message;if(['QUERY_TIMEOUT','QUERY_CANCELLED','RESULT_RELOAD_REQUIRED'].includes(problem.code)||adapter.alive===false){requiresReload=true;this.sessions.delete(request.token);}break;}
    }
    if(!error)for(const row of [...deletes].sort((a,b)=>b-a)){
      try{const ok=await execute(item,()=>this.remove(item,row));if(!ok)throw new Error(`Conflicto en la fila ${row+1}: fue modificada o eliminada. Vuelve a consultar.`);item.rows.splice(row,1);snapshot.results[item.index].values.splice(row,1);deleted.push(row);progress();}
      catch(problem){error=problem.message;if(['QUERY_TIMEOUT','QUERY_CANCELLED','RESULT_RELOAD_REQUIRED'].includes(problem.code)||adapter.alive===false)requiresReload=true;break;}
    }
    if(!error)for(const insert of insertRows){
      try{const values=await execute(item,()=>this.insert(item,insert.values));item.rows.push(structuredClone(values));snapshot.results[item.index].values.push(values);inserted.push({row:insert.row,values});progress();}
      catch(problem){error=problem.message;if(['QUERY_TIMEOUT','QUERY_CANCELLED','RESULT_RELOAD_REQUIRED'].includes(problem.code)||adapter.alive===false)requiresReload=true;break;}
    }
    if(error&&(deleted.length||inserted.length))requiresReload=true;
    if(requiresReload)this.sessions.delete(request.token);
    return {applied,deleted,inserted,error,requiresReload};
  }
  preview(request,snapshot,adapter,key){
    const item=this.sessions.get(request?.token);
    if(!item||item.snapshot!==snapshot||item.adapter!==adapter||item.key!==key||item.expires<Date.now())throw new Error('El resultado ha caducado o cambió su conexión. Vuelve a consultar la tabla.');
    const changesInput=Array.isArray(request.changes)?request.changes:[],deletes=Array.isArray(request.deletes)?request.deletes:[],inserts=Array.isArray(request.inserts)?request.inserts:[];
    const {engine,target,columns,primary}=item,table=quote(target.schema,engine)+'.'+quote(target.table,engine),names=columns.map(c=>quote(c.name,engine)),statements=[];
    const guards=(row,indices)=>indices.map(i=>`${names[i]}${item.rows[row][i]===null?' IS NULL':' = '+previewLiteral(item.rows[row][i])}`).join(' AND ');
    const grouped=new Map();for(const change of changesInput){if(!Number.isInteger(change?.row)||!item.rows[change.row]||!Number.isInteger(change.column)||!columns[change.column]?.editable)throw new Error('Cambio no válido para la vista previa.');if(!grouped.has(change.row))grouped.set(change.row,[]);grouped.get(change.row).push({...change,value:normalize(change.value,columns[change.column],engine)});}
    for(const [row,changes]of grouped){const keys=[...new Set([...primary,...changes.map(c=>c.column)])];statements.push(`UPDATE ${table}\nSET ${changes.map(c=>names[c.column]+' = '+previewLiteral(c.value)).join(', ')}\nWHERE ${guards(row,keys)};`);}
    for(const row of deletes){if(!Number.isInteger(row)||!item.rows[row])throw new Error('Fila a borrar no válida para la vista previa.');const keys=columns.map((c,i)=>c.primary||c.insertable?i:-1).filter(i=>i>=0);statements.push(`DELETE FROM ${table}\nWHERE ${guards(row,keys)};`);}
    const insertIds=new Set();for(const insert of inserts){if(!Number.isInteger(insert?.row)||insert.row<item.rows.length||insertIds.has(insert.row)||!Array.isArray(insert.values))throw new Error('Fila nueva no válida para la vista previa.');insertIds.add(insert.row);const seen=new Set(),values=[];for(const entry of insert.values){if(!Number.isInteger(entry?.column)||!columns[entry.column]?.insertable||seen.has(entry.column))throw new Error('Campo no válido en la fila nueva.');seen.add(entry.column);values.push({...entry,value:normalize(entry.value,columns[entry.column],engine)});}for(const i of primary)if(!seen.has(i)&&!columns[i].auto&&(columns[i].defaultValue==null||['mysql','mariadb'].includes(engine)))throw new Error(`Indica la clave ${columns[i].name} para la fila nueva antes de aplicar los cambios.`);const fields=values.map(x=>names[x.column]);statements.push(values.length?`INSERT INTO ${table} (${fields.join(', ')})\nVALUES (${values.map(x=>previewLiteral(x.value)).join(', ')});`:`INSERT INTO ${table} DEFAULT VALUES;`);}
    if(!statements.length)throw new Error('No hay cambios para mostrar.');return {engine,target:`${target.schema}.${target.table}`,statements};
  }
  async remove(item,row){
    const {adapter,engine,target,columns}=item,old=item.rows[row],table=quote(target.schema,engine)+'.'+quote(target.table,engine);
    const guards=columns.map((c,i)=>c.primary||c.insertable?i:-1).filter(i=>i>=0),names=columns.map(c=>quote(c.name,engine));
    if(engine==='sqlite'){adapter.database.run(`DELETE FROM ${table} WHERE ${guards.map(i=>names[i]+' IS ?').join(' AND ')}`,guards.map(i=>old[i]));return adapter.database.getRowsModified()===1;}
    if(engine==='postgresql'){const result=await adapter.client.query({text:`DELETE FROM ${table} WHERE ${guards.map((i,n)=>names[i]+' IS NOT DISTINCT FROM $'+(n+1)).join(' AND ')}`,values:guards.map(i=>old[i])});return result.rowCount===1;}
    const compare=i=>/char|text|enum|set/i.test(columns[i].type)?`BINARY CONVERT(${names[i]} USING utf8mb4) <=> BINARY ${literal(old[i])}`:`${names[i]} <=> ${literal(old[i])}`;
    const [info]=await adapter.connection.promise().query(`DELETE FROM ${table} WHERE ${guards.map(compare).join(' AND ')}`);return info.affectedRows===1;
  }
  async insert(item,values){
    const {adapter,engine,target,columns,primary}=item,table=quote(target.schema,engine)+'.'+quote(target.table,engine),names=columns.map(c=>quote(c.name,engine));
    const selected=values.map(c=>names[c.column]).join(','),returning=names.join(',');
    if(engine==='sqlite'){
      const sql=`INSERT INTO ${table} ${values.length?'('+selected+') VALUES ('+values.map(()=>'?').join(',')+')':'DEFAULT VALUES'} RETURNING ${returning}`;const statement=adapter.database.prepare(sql);
      try{statement.bind(values.map(c=>c.value));if(statement.step())return statement.get().map(resultCell);throw Object.assign(new Error('La fila se insertó pero no se pudo recargar. Vuelve a consultar.'),{code:'RESULT_RELOAD_REQUIRED'});}finally{statement.free();}
    }
    if(engine==='postgresql'){
      const sql=`INSERT INTO ${table} ${values.length?'('+selected+') VALUES ('+values.map((_,i)=>'$'+(i+1)).join(',')+')':'DEFAULT VALUES'} RETURNING ${returning}`;
      const result=await adapter.client.query({text:sql,values:values.map(c=>c.value),rowMode:'array'});if(result.rows[0])return result.rows[0].map(resultCell);throw Object.assign(new Error('La fila se insertó pero no se pudo recargar. Vuelve a consultar.'),{code:'RESULT_RELOAD_REQUIRED'});
    }
    if(primary.some(i=>!values.some(v=>v.column===i)&&!columns[i].auto))throw new Error('La clave primaria debe indicarse para insertar esta fila.');
    const sql=`INSERT INTO ${table} (${selected}) VALUES (${values.map(c=>literal(c.value)).join(',')})`;
    const [info]=await adapter.connection.promise().query(sql);const key=primary.map(i=>values.find(c=>c.column===i)?.value??(columns[i].auto?info.insertId:undefined));
    try{if(key.some((v,n)=>v===undefined||v===null||(v===0&&columns[primary[n]].auto&&!values.some(c=>c.column===primary[n]))))throw new Error('No se recibió la clave generada.');const [rows]=await adapter.connection.promise().query(`SELECT ${returning} FROM ${table} WHERE ${primary.map((i,n)=>names[i]+' <=> '+literal(key[n])).join(' AND ')}`);if(rows[0])return rows[0].map(resultCell);throw new Error('La fila ya no está disponible.');}catch(error){throw Object.assign(new Error('La fila se insertó pero no se pudo recargar. Vuelve a consultar. '+error.message),{code:'RESULT_RELOAD_REQUIRED'});}
  }
  async write(item,row,changes){
    const {engine,adapter,target,columns,primary}=item;const old=item.rows[row];const table=quote(target.schema,engine)+'.'+quote(target.table,engine);const guards=[...new Set([...primary,...changes.map(c=>c.column)])];
    const names=columns.map(c=>quote(c.name,engine));let result;
    if(engine==='sqlite'){
      const sql=`UPDATE ${table} SET ${changes.map(c=>names[c.column]+'=?').join(',')} WHERE ${guards.map(i=>names[i]+' IS ?').join(' AND ')}`;
      adapter.database.run(sql,[...changes.map(c=>c.value),...guards.map(i=>old[i])]);if(adapter.database.getRowsModified()!==1)return null;
      const statement=adapter.database.prepare(`SELECT ${names.join(',')} FROM ${table} WHERE ${primary.map(i=>names[i]+' IS ?').join(' AND ')}`);try{statement.bind(primary.map(i=>old[i]));if(statement.step())return statement.get().map(resultCell);throw Object.assign(new Error('La fila se actualizó pero no se pudo recargar. Vuelve a consultar la tabla.'),{code:'RESULT_RELOAD_REQUIRED'});}finally{statement.free();}
    }
    if(engine==='postgresql'){
      const params=[];const param=value=>{params.push(value);return '$'+params.length;};
      const sql=`UPDATE ${table} SET ${changes.map(c=>names[c.column]+'='+param(c.value)).join(',')} WHERE ${guards.map(i=>names[i]+' IS NOT DISTINCT FROM '+param(old[i])).join(' AND ')} RETURNING ${names.join(',')}`;
      result=await adapter.client.query({text:sql,values:params,rowMode:'array'});if(result.rowCount!==1)return null;return result.rows[0].map(resultCell);
    }
    const compare=(i,value)=>{const text=/char|text|enum|set/i.test(columns[i].type);return text?`BINARY CONVERT(${names[i]} USING utf8mb4) <=> BINARY ${literal(value)}`:`${names[i]} <=> ${literal(value)}`;};
    const sql=`UPDATE ${table} SET ${changes.map(c=>names[c.column]+'='+literal(c.value)).join(',')} WHERE ${guards.map(i=>compare(i,old[i])).join(' AND ')}`;
    const [info]=await adapter.connection.promise().query(sql);if(info.affectedRows!==1)return null;
    let rows;try{[rows]=await adapter.connection.promise().query(`SELECT ${names.join(',')} FROM ${table} WHERE ${primary.map(i=>compare(i,old[i])).join(' AND ')}`);}catch(problem){throw Object.assign(new Error('La fila se actualizó pero no se pudo recargar. Vuelve a consultar la tabla. '+problem.message),{code:'RESULT_RELOAD_REQUIRED'});}
    if(!rows[0])throw Object.assign(new Error('La fila se actualizó pero no se pudo recargar. Vuelve a consultar la tabla.'),{code:'RESULT_RELOAD_REQUIRED'});return rows[0].map(resultCell);
  }
}
module.exports={ResultEdits,targetFromSQL,decorateResult,normalize};
