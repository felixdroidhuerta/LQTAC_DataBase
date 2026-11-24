const test=require('node:test'),assert=require('node:assert/strict');
const {SQLiteAdapter}=require('../src/adapters/sqlite.cjs');const {ResultEdits,decorateResult,normalize}=require('../src/result-edit.cjs');
async function setup(){const adapter=await SQLiteAdapter.open();adapter.database.run("CREATE TABLE records(id INTEGER PRIMARY KEY,name TEXT UNIQUE,qty INTEGER);INSERT INTO records VALUES(1,'Alpha',10),(2,'Beta',20),(3,'Gamma',30)");const sql='SELECT * FROM records',result=adapter.execute(sql).results[0];decorateResult(result,{sql,engine:'sqlite',database:'main',adapter});const snapshot={results:[result]},service=new ResultEdits(),info=await service.open(snapshot,0,adapter,'sqlite','local');return{adapter,snapshot,service,info};}
test('numeric values from autofill remain valid and unsafe values explain the failure',()=>{
 const column={name:'dni_queue',type:'int',nullable:true};assert.equal(normalize(98,column,'mysql'),'98');assert.equal(normalize(1,column,'sqlite'),1);assert.equal(normalize(null,column,'mysql'),null);
 assert.throws(()=>normalize(Number.MAX_SAFE_INTEGER+1,column,'mysql'),/seguridad/);assert.throws(()=>normalize(undefined,column,'mysql'),/undefined/);assert.throws(()=>normalize('x'.repeat(1000001),{...column,type:'text'},'sqlite'),/millón/);
});
test('validation reports every bad cell with original identity, old and new values before writing',async()=>{
 const {adapter,snapshot,service,info}=await setup();try{
  const request={token:info.token,changes:[{row:0,column:2,value:'invalid'},{row:1,column:2,value:'other'}]};let error;
  try{service.preview(request,snapshot,adapter,'local');}catch(e){error=e;}
  assert.equal(error.editDiagnostics.total,2);const first=error.editDiagnostics.issues[0];assert.equal(first.target,'main.records');assert.deepEqual(first.keys,[{name:'id',value:1}]);assert.equal(first.fields[0].name,'qty');assert.equal(first.fields[0].oldValue,10);assert.equal(first.fields[0].newValue,'invalid');
  await assert.rejects(service.apply(request,snapshot,adapter,'local',async(_item,action)=>action()),e=>e.editDiagnostics.total===2);
  assert.deepEqual(adapter.database.exec('SELECT qty FROM records')[0].values,[[10],[20],[30]]);
 }finally{adapter.close();}
});
test('server failures identify the exact mutation and retain the number already applied',async()=>{
 const {adapter,snapshot,service,info}=await setup();try{
  const result=await service.apply({token:info.token,changes:[{row:0,column:1,value:'Changed'},{row:1,column:1,value:'Gamma'}]},snapshot,adapter,'local',async(_item,action)=>action());
  assert.equal(result.applied.length,1);assert.match(result.error,/UNIQUE/);const issue=result.errorDetails.issues[0];assert.equal(issue.rowIndex,1);assert.deepEqual(issue.keys,[{name:'id',value:2}]);assert.equal(issue.fields[0].oldValue,'Beta');assert.equal(issue.fields[0].newValue,'Gamma');assert.match(issue.sql,/UPDATE/);assert.match(issue.sql,/Gamma/);assert.match(issue.sql,/"id" = 2/);
  assert.deepEqual(adapter.database.exec('SELECT name FROM records ORDER BY id')[0].values,[['Changed'],['Beta'],['Gamma']]);
 }finally{adapter.close();}
});
