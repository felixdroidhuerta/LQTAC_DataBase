const {splitSQL}=require('./sql-statements.cjs');
const {pathToFileURL}=require('node:url');const path=require('node:path');
function refreshQuery(sql,engine){
 if(typeof sql!=='string'||!sql.trim())throw Error('La fuente no tiene una consulta guardada.');
 if(engine==='mongodb'){const command=JSON.parse(sql);if(!['find','aggregate'].includes(Object.keys(command||{})[0]))throw Error('Solo se actualizan fuentes MongoDB find o aggregate.');if((function writes(value){return value&&typeof value==='object'&&Object.entries(value).some(([k,v])=>['$out','$merge'].includes(k)||writes(v));})(command))throw Error('La actualización no admite escrituras MongoDB.');return sql;}
 const statements=splitSQL(sql,engine);if(statements.length!==1)throw Error('La fuente debe guardar una sola consulta de lectura.');
 // Ignore quoted values and identifiers when checking commands; executable comments are rejected.
 if(/\/\*[!+]/.test(sql))throw Error('No se admiten comentarios ejecutables en una actualización.');
 const code=sql.replace(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|#[^\n]*(?:\n|$)|\$(?:[a-zA-Z_]\w*)?\$[\s\S]*?\$(?:[a-zA-Z_]\w*)?\$|'(?:''|\\.|[^'\\])*'|"(?:""|[^"\\]|\\.)*"|\x60(?:\x60\x60|[^\x60])*\x60|\[(?:\]\]|[^\]])*\]/g,' ');
 if(!/^\s*(SELECT|WITH)\b/i.test(code)||/\b(INSERT|UPDATE|DELETE|MERGE|REPLACE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|CALL|EXEC|EXECUTE|INTO|OUTFILE|DUMPFILE|ATTACH|DETACH|PRAGMA|SET|COPY|GRANT|REVOKE)\b/i.test(code))throw Error('Actualizar fuentes solo admite SELECT o WITH de lectura, sin escrituras.');return statements[0].sql;
}
async function refreshBoard(input,ids,execute){
 const {validateBoard,joinDatasets}=await import(pathToFileURL(path.join(__dirname,'renderer/dashboard-model.mjs')).href);
 const {recalculateColumns}=await import(pathToFileURL(path.join(__dirname,'renderer/dashboard-formulas.mjs')).href);
 const board=validateBoard(input);if(!Array.isArray(ids)||!ids.length||ids.length>12||new Set(ids).size!==ids.length||ids.some(id=>!board.datasets.some(d=>d.id===id)))throw Error('Elige fuentes válidas para actualizar.');
 const selected=new Set(ids);let expand=true;while(expand){expand=false;for(const d of board.datasets)if(d.source?.kind==='relationship'&&d.source.parents?.some(id=>selected.has(id))&&!selected.has(d.id)){selected.add(d.id);expand=true;}}
 const pending=board.datasets.filter(d=>selected.has(d.id)),done=new Set();
 while(pending.length){const i=pending.findIndex(d=>d.source?.kind!=='relationship'||d.source.parents.every(id=>!selected.has(id)||done.has(id)));if(i<0)throw Error('Las fuentes combinadas contienen un ciclo.');const d=pending.splice(i,1)[0];try{
 const count=d.calculations?.length||0,baseColumns=d.columns.slice(0,d.columns.length-count);let result;
 if(d.source?.kind==='relationship'){const {parents,leftColumn,rightColumn,joinKind}=d.source;if(!Number.isInteger(leftColumn)||!Number.isInteger(rightColumn))throw Error('Esta combinación antigua debe recrearse una vez para guardar sus claves.');const left=board.datasets.find(x=>x.id===parents[0]),right=board.datasets.find(x=>x.id===parents[1]);const joined=joinDatasets(left,right,leftColumn,rightColumn,joinKind,d.id);result={columns:joined.columns,values:joined.rows,truncated:joined.truncated};}
 else{refreshQuery(d.source?.sql,d.source?.engine);result=await execute(d.source);}
 if(JSON.stringify(result.columns)!==JSON.stringify(baseColumns))throw Error('Ha cambiado la estructura de columnas. Se conservan los datos anteriores.');
 d.rows=result.values.map(row=>[...row,...Array(count).fill(null)]);d.truncated=!!result.truncated;recalculateColumns(d);d.source={...d.source,...result.sourceContext,capturedAt:new Date().toISOString()};done.add(d.id);
 }catch(error){throw Error(d.name+': '+error.message);}}
 board.lastRefreshedAt=new Date().toISOString();return validateBoard(board);
}
module.exports={refreshBoard,refreshQuery};
