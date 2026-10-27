const {test}=require('node:test');const assert=require('node:assert/strict');const ExcelJS=require('exceljs');
const {formatQuery,visibleResults,exportResult,relationGraph,readRelations}=require('../src/query-tools.cjs');
const {SQLiteAdapter}=require('../src/adapters/sqlite.cjs');
test('formatting preserves literals/comments and supports SQL dialects without executing',()=>{
  for(const engine of ['mysql','mariadb','postgresql','sqlserver','oracle','sqlite','clickhouse']){const value=formatQuery("select a, 'x, y' from t where a=1 -- comentario",engine);assert.match(value,/\n/);assert.match(value,/'x, y'/);assert.match(value,/-- comentario/);}
  assert.equal(JSON.parse(formatQuery('{"find":"t","filter":{}}','mongodb')).find,'t');assert.throws(()=>formatQuery('select 1','invalid'),/Motor/);
});
test('UI row caps preserve columns and mark truncation without mutating the query results',()=>{
  const original={results:[{columns:['x'],values:Array.from({length:80},(_,n)=>[n]),truncated:false}],changes:3};const limited=visibleResults(original,50);assert.equal(limited.results[0].values.length,50);assert.equal(limited.results[0].truncated,true);assert.equal(original.results[0].values.length,80);assert.equal(limited.changes,3);assert.throws(()=>visibleResults(original,0));
});
test('CSV and XLSX preserve Unicode, quotes, numbers, duplicate headers, nulls and formula-like text',async()=>{
  const result={columns:['id','texto','texto'],values:[[1,'á,"b"\nnext',null],[2,'=1+1','0000123'],[-3,'@SUM(A1)','9007199254740993']]};
  const csv=(await exportResult(result,'csv')).toString('utf8');assert.match(csv,/^\uFEFF/);assert.match(csv,/"á,""b""\nnext"/);assert.match(csv,/'=1\+1/);assert.match(csv,/"-3"/);
  const bytes=await exportResult(result,'xlsx');const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes);const sheet=workbook.worksheets[0];assert.equal(sheet.getCell('B3').value,'=1+1');assert.equal(sheet.getCell('C3').value,'0000123');assert.equal(sheet.getCell('C4').value,'9007199254740993');assert.equal(sheet.getCell('C1').value,'texto');assert.equal(sheet.getCell('B2').value,'á,"b"\nnext');assert.equal(sheet.getCell('A4').value,-3);
  await assert.rejects(exportResult({columns:['x'],values:[['x'.repeat(32768)]]},'xlsx'),/32.767/);
});
test('relationship graph reads declared SQLite foreign keys and groups composite edges',async()=>{
  const adapter=await SQLiteAdapter.open();try{adapter.execute('CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(id INTEGER, parent_id INTEGER REFERENCES parent(id));');const schemas=[{name:'main',objects:adapter.schema()}];const graph=await readRelations(adapter,'sqlite','main',schemas);assert.equal(graph.edges.length,1);assert.equal(graph.edges[0].columns[0].from,'parent_id');assert.deepEqual(JSON.parse(graph.edges[0].to),['main','parent']);const compound=relationGraph([['fk','a','c','x','a','p','i'],['fk','a','c','y','a','p','j']],[]);assert.equal(compound.edges.length,1);assert.equal(compound.edges[0].columns.length,2);assert.match((await readRelations({},'mongodb','main',schemas)).warning,/No se deducen/);}finally{adapter.close();}
});
