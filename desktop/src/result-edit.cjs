const {randomUUID,createHash}=require('node:crypto');
const {identifier,cell}=require('./adapters/sql-common.cjs');
const quote=(name,engine)=>['mysql','mariadb'].includes(engine)?'`'+name.replaceAll('`','``')+'`':identifier(name,engine);
const literal=value=>value===null?'NULL':value===''?"''":`CONVERT(0x${Buffer.from(String(value),'utf8').toString('hex')} USING utf8mb4)`;
const resultCell=value=>value instanceof Uint8Array?`[BLOB ${value.length} bytes]`:cell(value);
function targetFromSQL(sql,engine,database){
  if(!['sqlite','mysql','mariadb','postgresql'].includes(engine)||typeof sql!=='string')return null;
  const tokens=[];let i=0;
  while(i<sql.length){
    const c=sql[i];if(/\s/.test(c)){i++;continue;}
    if(sql.startsWith('--',i)){const end=sql.indexOf('\n',i+2);i=end<0?sql.length:end+1;continue;}
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
async function describe(adapter,engine,target){
  const {schema,table}=target;let columns=[];
  if(engine==='sqlite'){
    const type=adapter.database.exec(`SELECT type FROM ${quote(schema,engine)}.sqlite_master WHERE name='${table.replaceAll("'","''")}'`)[0]?.values[0]?.[0];if(type!=='table')throw new Error('Solo se editan tablas, no vistas.');
    columns=(adapter.database.exec(`PRAGMA ${quote(schema,engine)}.table_xinfo(${quote(table,engine)})`)[0]?.values||[]).map(row=>({name:row[1],type:row[2],primary:Number(row[5])>0,nullable:!row[3],generated:Number(row[6])!==0}));
  }else if(['mysql','mariadb'].includes(engine)){
    const qualified=quote(schema,engine)+'.'+quote(table,engine);
    const [,definitionFields]=await adapter.connection.promise().query('SHOW CREATE TABLE '+qualified);if(!definitionFields?.some(f=>f.name==='Create Table'))throw new Error('Solo se editan tablas, no vistas.');
    const records=async sql=>{const [rows,fields]=await adapter.connection.promise().query(sql);return rows.map(row=>Object.fromEntries(fields.map((field,i)=>[field.name,row[i]])));};
    const indexes=await records('SHOW INDEX FROM '+qualified),keys=new Set(indexes.filter(row=>row.Key_name==='PRIMARY').map(row=>row.Column_name));
    const rows=await records('SHOW FULL COLUMNS FROM '+qualified);
    columns=rows.map(row=>({name:row.Field,type:row.Type,primary:keys.has(row.Field),nullable:row.Null==='YES',generated:/GENERATED/i.test(row.Extra||'')}));
  }else if(engine==='postgresql'){
    const {rows}=await adapter.client.query({text:`SELECT c.oid::text,a.attname,format_type(a.atttypid,a.atttypmod),EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)),NOT a.attnotnull,COALESCE(to_jsonb(a)->>'attgenerated','') FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p') AND (c.relkind='p' OR NOT EXISTS(SELECT 1 FROM pg_inherits inh WHERE inh.inhparent=c.oid)) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,values:[schema,table],rowMode:'array'});
    if(target.oid&&rows[0]?.[0]!==String(target.oid))throw new Error('El origen del resultado ya no corresponde a esta tabla.');
    columns=rows.map(([,name,type,primary,nullable,generated])=>({name,type,primary,nullable,generated:!!generated}));
  }else throw new Error('La edición de datos de este motor no está disponible.');
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
  async open(snapshot,index,adapter,engine,key){
    const result=snapshot?.results?.[index];if(!result?.editContext||!result.values.length)throw new Error('Abre los datos de una única tabla con SELECT * para editarlos.');
    const target=result.editContext;const metadata=await describe(adapter,engine,target);
    const columns=result.columns.map(name=>metadata.columns.find(column=>column.name===name));
    if(columns.some(c=>!c)||new Set(result.columns).size!==result.columns.length||metadata.columns.some(c=>c.primary&&!result.columns.includes(c.name)))throw new Error('El resultado debe incluir los campos y la clave primaria de una única tabla.');
    const unsupported=c=>/blob|binary|bytea|json|xml|interval|geometry|geography|point|polygon|array|\[\]/i.test(c.type);
    columns.forEach(c=>{c.editable=!c.primary&&!c.generated&&!unsupported(c);});
    const primary=columns.map((c,i)=>c.primary?i:-1).filter(i=>i>=0);const seen=new Set();
    for(const row of result.values){const identity=primary.map(i=>row[i]);if(identity.some(v=>v===null||v===undefined||typeof v==='number'&&!Number.isSafeInteger(v)))throw new Error('La clave de una fila no se puede representar con seguridad.');const id=JSON.stringify(identity);if(seen.has(id))throw new Error('Hay claves duplicadas en este resultado.');seen.add(id);}
    const token=randomUUID();for(const [id,item]of this.sessions)if(item.expires<Date.now()||item.snapshot!==snapshot||item.index===index)this.sessions.delete(id);
    this.sessions.set(token,{snapshot,index,adapter,engine,key,target,columns,primary,metadata:metadata.fingerprint,rows:structuredClone(result.values),expires:Date.now()+1800000});
    return {token,target:`${target.schema}.${target.table}`,columns:columns.map(c=>({name:c.name,type:c.type,editable:c.editable,nullable:c.nullable,primary:c.primary}))};
  }
  async apply(request,snapshot,adapter,key,execute,onProgress=()=>{}){
    const item=this.sessions.get(request?.token);
    if(!item||item.snapshot!==snapshot||item.adapter!==adapter||item.key!==key||item.expires<Date.now())throw new Error('El resultado ha caducado o cambió su conexión. Vuelve a consultar la tabla.');
    if(!Array.isArray(request.changes)||!request.changes.length||request.changes.length>10000||Buffer.byteLength(JSON.stringify(request.changes))>8000000)throw new Error('La edición supera el límite permitido.');
    if((await describe(adapter,item.engine,item.target)).fingerprint!==item.metadata)throw new Error('Cambió la estructura de la tabla. Vuelve a consultarla.');
    const groups=new Map();const cells=new Set();
    for(const change of request.changes){const {row,column,value}=change||{};if(!Number.isInteger(row)||!item.rows[row]||!Number.isInteger(column)||!item.columns[column]?.editable)throw new Error('Celda no editable.');const id=`${row}:${column}`;if(cells.has(id))throw new Error('Hay cambios duplicados.');cells.add(id);if(!groups.has(row))groups.set(row,[]);groups.get(row).push({column,value:normalize(value,item.columns[column],item.engine)});}
    const applied=[];let error,requiresReload=false;
    onProgress({completed:0,total:groups.size});
    for(const [row,changes]of groups){
      try{
        const values=await execute(item,()=>this.write(item,row,changes));
        if(!values)throw new Error(`Conflicto en la fila ${row+1}: fue modificada o eliminada. Vuelve a consultar.`);
        item.rows[row]=structuredClone(values);snapshot.results[item.index].values[row]=values;applied.push({row,values});onProgress({completed:applied.length,total:groups.size});
      }catch(problem){error=problem.message;if(['QUERY_TIMEOUT','QUERY_CANCELLED','RESULT_RELOAD_REQUIRED'].includes(problem.code)||adapter.alive===false){requiresReload=true;this.sessions.delete(request.token);}break;}
    }
    return {applied,error,requiresReload};
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
