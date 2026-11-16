const {test}=require('node:test');const assert=require('node:assert/strict');
const {SQLiteAdapter}=require('../src/adapters/sqlite.cjs');const {ResultEdits,decorateResult,targetFromSQL}=require('../src/result-edit.cjs');
async function setup(){const adapter=await SQLiteAdapter.open();adapter.execute('CREATE TABLE records(id INTEGER PRIMARY KEY,name TEXT NOT NULL,amount INTEGER,note TEXT);INSERT INTO records VALUES(1,\'Alpha\',10,NULL),(2,\'Beta\',20,\'\'),(3,\'Gamma\',30,\'original\')');const sql='SELECT * FROM main.records';const result=adapter.execute(sql).results[0];decorateResult(result,{sql,engine:'sqlite',database:'main',adapter});const snapshot={results:[result]};const service=new ResultEdits();const info=await service.open(snapshot,0,adapter,'sqlite','local');return{adapter,snapshot,service,info};}
const execute=async(_item,write)=>write();
test('SQLite permite preparar, insertar y borrar filas con valores predeterminados y sin sobrescribir cambios concurrentes',async()=>{
  const {adapter,snapshot,service,info}=await setup();try{
    const result=await service.apply({token:info.token,changes:[{row:0,column:1,value:'editado'}],deletes:[1],inserts:[{row:3,values:[{column:1,value:'nueva'},{column:2,value:'45'}]}]},snapshot,adapter,'local',execute);
    assert.equal(result.applied.length,1);assert.deepEqual(result.deleted,[1]);assert.equal(result.inserted.length,1);assert.deepEqual(adapter.database.exec('SELECT id,name,amount FROM records ORDER BY id')[0].values,[[1,'editado',10],[3,'Gamma',30],[4,'nueva',45]]);
    assert.deepEqual(snapshot.results[0].values.map(row=>row[0]),[1,3,4]);
    adapter.database.run("UPDATE records SET name='externa' WHERE id=3");
    const conflict=await service.apply({token:info.token,changes:[],deletes:[1],inserts:[]},snapshot,adapter,'local',execute);assert.match(conflict.error,/Conflicto/);assert.equal(adapter.database.exec('SELECT count(*) FROM records WHERE id=3')[0].values[0][0],1);
  }finally{adapter.close();}
});
test('una tabla vacía permite preparar inserciones y validar antes de escribir',async()=>{
  const adapter=await SQLiteAdapter.open();try{adapter.execute('CREATE TABLE empty_rows(id INTEGER PRIMARY KEY,name TEXT NOT NULL)');const result=adapter.execute('SELECT * FROM empty_rows').results[0];decorateResult(result,{sql:'SELECT * FROM empty_rows',engine:'sqlite',database:'main',adapter});const snapshot={results:[result]},service=new ResultEdits(),info=await service.open(snapshot,0,adapter,'sqlite','local');const response=await service.apply({token:info.token,changes:[],inserts:[{row:0,values:[{column:1,value:'primera'}]}]},snapshot,adapter,'local',execute);assert.deepEqual(response.inserted[0].values,[1,'primera']);}finally{adapter.close();}
});
test('la vista previa de cambios muestra el SQL de edición, borrado e inserción sin escribir datos',async()=>{
  const {adapter,snapshot,service,info}=await setup();try{
    const preview=service.preview({token:info.token,changes:[{row:0,column:1,value:'Renombrado'}],deletes:[1],inserts:[{row:3,values:[{column:1,value:'Nueva'},{column:2,value:'42'}]}]},snapshot,adapter,'local');
    assert.equal(preview.statements.length,3);assert.match(preview.statements[0],/UPDATE "main"\."records"/);assert.match(preview.statements[0],/SET "name" = 'Renombrado'/);assert.match(preview.statements[1],/DELETE FROM/);assert.match(preview.statements[2],/INSERT INTO/);assert.equal(adapter.database.exec('SELECT count\(\*\) FROM records')[0].values[0][0],3);
  }finally{adapter.close();}
});
test('la vista previa exige una clave primaria manual antes de intentar insertar en MySQL',()=>{
  const service=new ResultEdits(),adapter={},snapshot={results:[]},token='preview-manual-key';
  service.sessions.set(token,{snapshot,adapter,engine:'mysql',key:'local',target:{schema:'test',table:'manual_key'},columns:[{name:'id',type:'int',primary:true,auto:false,insertable:true,editable:false,nullable:false,defaultValue:null},{name:'name',type:'varchar(50)',primary:false,auto:false,insertable:true,editable:true,nullable:true,defaultValue:null}],primary:[0],rows:[],expires:Date.now()+1000});
  assert.throws(()=>service.preview({token,changes:[],deletes:[],inserts:[{row:0,values:[{column:1,value:'sin clave'}]}]},snapshot,adapter,'local'),/Indica la clave id/);
});
test('las altas y bajas MySQL y PostgreSQL aíslan valores y comprueban la fila original',async()=>{
  const service=new ResultEdits(),attack="x'; DELETE FROM t; --",columns=[{name:'id',type:'int',primary:true,auto:true,insertable:true},{name:'name',type:'text',insertable:true}],calls=[];
  const mysql={connection:{promise:()=>({query:async sql=>{calls.push(sql);if(sql.startsWith('INSERT'))return[{insertId:9}];if(sql.startsWith('DELETE'))return[{affectedRows:1}];return[[[9,attack]]];}})}};
  const mi={engine:'mysql',adapter:mysql,target:{schema:'test',table:'t'},columns,primary:[0],rows:[[9,attack]]};assert.deepEqual(await service.insert(mi,[{column:1,value:attack}]),[9,attack]);assert.equal(await service.remove(mi,0),true);assert.ok(calls.every(sql=>!sql.includes(attack)));assert.match(calls.at(-1),/WHERE.*id.*name/);
  const callsPg=[],postgres={client:{query:async q=>{callsPg.push(q);return q.text.startsWith('INSERT')?{rows:[[9,attack]]}:{rowCount:1};}}};
  const pi={...mi,engine:'postgresql',adapter:postgres};assert.deepEqual(await service.insert(pi,[{column:1,value:attack}]),[9,attack]);assert.equal(await service.remove(pi,0),true);assert.ok(callsPg.every(q=>!q.text.includes(attack)));assert.equal(callsPg[0].values[0],attack);assert.deepEqual(callsPg[1].values,[9,attack]);
});
test('only direct single-table star results are candidates; joins, unions, expressions and extra statements are read-only',()=>{
  assert.equal(targetFromSQL('SELECT * FROM `crmti`.`records` WHERE name=\'JOIN x\' LIMIT 100','mysql','test').table,'records');
  assert.equal(targetFromSQL('# Consulta de mantenimiento\nSELECT -- campos comentados\n * FROM ws_service WHERE service_flag=1','mysql','db_webservices').table,'ws_service');
  for(const sql of ['SELECT a.id FROM a','SELECT * FROM a JOIN b ON a.id=b.id','SELECT * FROM a,b','SELECT * FROM a UNION SELECT * FROM b','WITH a AS(SELECT 1) SELECT * FROM a','SELECT * FROM a; UPDATE a SET x=1','SELECT * FROM (SELECT * FROM a) x'])assert.equal(targetFromSQL(sql,'mysql','test'),null,sql);
});
test('SQLite changes are bound to original row identities, preserve NULL/text and do not commit an existing transaction',async()=>{
  const {adapter,snapshot,service,info}=await setup();try{
    assert.equal(info.columns[0].editable,false);assert.equal(info.columns[1].editable,true);
    const text="' ; DROP TABLE records; --\nUnicode á 🐙";
    adapter.database.run('BEGIN');const response=await service.apply({token:info.token,changes:[{row:2,column:1,value:text},{row:0,column:3,value:''},{row:1,column:3,value:null}]},snapshot,adapter,'local',execute);
    assert.equal(response.applied.length,3);assert.equal(adapter.database.exec('SELECT name FROM records WHERE id=3')[0].values[0][0],text);assert.equal(snapshot.results[0].values[2][1],text);
    assert.equal(adapter.database.exec('SELECT note FROM records WHERE id=1')[0].values[0][0],null);assert.equal(adapter.database.exec('SELECT note FROM records WHERE id=2')[0].values[0][0],null);
    adapter.database.run('ROLLBACK');assert.equal(adapter.database.exec('SELECT name FROM records WHERE id=3')[0].values[0][0],'Gamma');
  }finally{adapter.close();}
});
test('validate all changes before writing; reject key edits, stale snapshots, different sessions and schema changes',async()=>{
  const {adapter,snapshot,service,info}=await setup();try{
    await assert.rejects(service.apply({token:info.token,changes:[{row:0,column:1,value:'must not write'},{row:1,column:2,value:'abc'}]},snapshot,adapter,'local',execute),/entero/);
    assert.equal(adapter.database.exec('SELECT name FROM records WHERE id=1')[0].values[0][0],'Alpha');
    await assert.rejects(service.apply({token:info.token,changes:[{row:0,column:0,value:'10'}]},snapshot,adapter,'local',execute),/editable/);
    await assert.rejects(service.apply({token:info.token,changes:[{row:0,column:1,value:'x'}]},{results:[]},adapter,'local',execute),/caducado/);
    await assert.rejects(service.apply({token:info.token,changes:[{row:0,column:1,value:'x'}]},snapshot,adapter,'another',execute),/conexión/);
    adapter.database.run('ALTER TABLE records ADD COLUMN extra TEXT');await assert.rejects(service.apply({token:info.token,changes:[{row:0,column:1,value:'x'}]},snapshot,adapter,'local',execute),/estructura/);
  }finally{adapter.close();}
});
test('optimistic updates preserve concurrent changes and return exact partial success when a later row conflicts',async()=>{
  const {adapter,snapshot,service,info}=await setup();try{
    adapter.database.run("UPDATE records SET name='changed externally' WHERE id=2");
    const response=await service.apply({token:info.token,changes:[{row:0,column:1,value:'saved'},{row:1,column:1,value:'do not overwrite'},{row:2,column:1,value:'not reached'}]},snapshot,adapter,'local',execute);
    assert.equal(response.applied.length,1);assert.match(response.error,/Conflicto/);assert.deepEqual(adapter.database.exec('SELECT name FROM records ORDER BY id')[0].values,[['saved'],['changed externally'],['Gamma']]);
  }finally{adapter.close();}
});
test('MySQL encodes values independently of SQL mode; PostgreSQL binds values rather than interpolating SQL',async()=>{
  for(const engine of ['mysql','postgresql']){
    let row=[1,'before'];const calls=[];const attack="new'\\; DROP TABLE records; --";
    const adapter=engine==='mysql'?{connection:{promise:()=>({query:async sql=>{calls.push(sql);if(sql.startsWith('SHOW CREATE TABLE'))return[[['records','CREATE TABLE records']],['Table','Create Table'].map(name=>({name}))];if(sql.startsWith('SHOW INDEX'))return[[['PRIMARY','id']],['Key_name','Column_name'].map(name=>({name}))];if(sql.startsWith('SHOW FULL COLUMNS'))return[[['id','int','NO',''],['name','varchar(255)','NO','']],['Field','Type','Null','Extra'].map(name=>({name}))];if(sql.startsWith('UPDATE')){assert.ok(!sql.includes(attack));const hex=/SET `name`=CONVERT\(0x([a-f0-9]+)/.exec(sql)[1];row=[1,Buffer.from(hex,'hex').toString('utf8')];return[{affectedRows:1}];}return[[row]];}})}}:{client:{query:async query=>{calls.push(query.text);if(query.text.startsWith('SELECT c.oid'))return{rows:[['12','id','integer',true,false,''],['12','name','text',false,false,'']]};assert.ok(!query.text.includes(attack));assert.equal(query.values[0],attack);row=[1,query.values[0]];return{rowCount:1,rows:[row]};}}};
    const snapshot={results:[{columns:['id','name'],values:[[1,'before']],editContext:{schema:'main',table:'records'}}]};const service=new ResultEdits();const info=await service.open(snapshot,0,adapter,engine,'profile');const response=await service.apply({token:info.token,changes:[{row:0,column:1,value:attack}]},snapshot,adapter,'profile',execute);assert.equal(response.applied[0].values[1],attack);
    if(engine==='mysql'){const original=adapter.connection.promise;adapter.connection.promise=()=>({query:async sql=>{if(sql.startsWith('SELECT `id`'))throw new Error('Fixture lost read response');return original().query(sql);}});const uncertain=await service.apply({token:info.token,changes:[{row:0,column:1,value:'next'}]},snapshot,adapter,'profile',execute);assert.equal(uncertain.requiresReload,true);assert.match(uncertain.error,/fila se actualizó/);await assert.rejects(service.apply({token:info.token,changes:[{row:0,column:1,value:'again'}]},snapshot,adapter,'profile',execute),/caducado/);}
  }
});
test('views and tables without keys remain read-only; generated fields cannot be written',async()=>{
  const adapter=await SQLiteAdapter.open();try{
    adapter.execute("CREATE TABLE keyed(id INTEGER PRIMARY KEY,name TEXT,calculated TEXT GENERATED ALWAYS AS(name||'!') VIRTUAL);INSERT INTO keyed(id,name) VALUES(1,'a');CREATE TABLE no_key(name TEXT);INSERT INTO no_key VALUES('x');CREATE VIEW read_view AS SELECT * FROM keyed");
    const service=new ResultEdits();
    for(const table of ['no_key','read_view']){const result=adapter.execute('SELECT * FROM main.'+table).results[0];result.editContext={schema:'main',table};await assert.rejects(service.open({results:[result]},0,adapter,'sqlite','local'));}
    const result=adapter.execute('SELECT * FROM main.keyed').results[0];result.editContext={schema:'main',table:'keyed'};const snapshot={results:[result]};const info=await service.open(snapshot,0,adapter,'sqlite','local');assert.equal(info.columns[2].editable,false);await assert.rejects(service.apply({token:info.token,changes:[{row:0,column:2,value:'override'}]},snapshot,adapter,'local',execute),/editable/);
  }finally{adapter.close();}
});
test('an uncertain write invalidates the edit token and is never automatically repeated',async()=>{
  const {adapter,snapshot,service,info}=await setup();try{let calls=0;const request={token:info.token,changes:[{row:0,column:1,value:'changed'}]};const response=await service.apply(request,snapshot,adapter,'local',async()=>{calls++;throw Object.assign(new Error('Agotado tiempo máximo de consulta'),{code:'QUERY_TIMEOUT'});});assert.equal(response.requiresReload,true);assert.equal(calls,1);await assert.rejects(service.apply(request,snapshot,adapter,'local',execute),/caducado/);assert.equal(calls,1);}finally{adapter.close();}
});
test('an explicitly qualified SQLite table is never confused with a shadowing temporary table, including comments',async()=>{
  const adapter=await SQLiteAdapter.open();try{adapter.execute("CREATE TABLE same_name(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO main.same_name VALUES(1,'before');CREATE TEMP TABLE same_name(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO temp.same_name VALUES(1,'before')");const sql='SELECT * FROM /* table hint */ main.same_name';const result=adapter.execute(sql).results[0];decorateResult(result,{sql,engine:'sqlite',database:'main',adapter});assert.equal(result.editContext.schema,'main');const snapshot={results:[result]},service=new ResultEdits(),info=await service.open(snapshot,0,adapter,'sqlite','local');await service.apply({token:info.token,changes:[{row:0,column:1,value:'updated main'}]},snapshot,adapter,'local',execute);assert.equal(adapter.database.exec('SELECT name FROM main.same_name')[0].values[0][0],'updated main');assert.equal(adapter.database.exec('SELECT name FROM temp.same_name')[0].values[0][0],'before');}finally{adapter.close();}
});
test('an unqualified temporary view cannot cause an update of the permanent table it hides',async()=>{
  const adapter=await SQLiteAdapter.open();try{adapter.execute("CREATE TABLE hidden(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO main.hidden VALUES(1,'before');CREATE TEMP VIEW hidden AS SELECT 1 AS id,'before' AS name");const sql='SELECT * FROM hidden',result=adapter.execute(sql).results[0];decorateResult(result,{sql,engine:'sqlite',database:'main',adapter});assert.equal(result.editContext.schema,'temp');await assert.rejects(new ResultEdits().open({results:[result]},0,adapter,'sqlite','local'),/vistas/);assert.equal(adapter.database.exec('SELECT name FROM main.hidden')[0].values[0][0],'before');}finally{adapter.close();}
});
test('MySQL edit metadata uses the actual protocol and named SHOW fields for keys and column types',async()=>{
  const {startMySQLFixture}=require('./mysql-fixture.cjs');const {MySQLAdapter}=require('../src/adapters/mysql.cjs');const server=await startMySQLFixture();const adapter=await MySQLAdapter.open(server.profile,'fixture');try{const snapshot={results:[{columns:['id','nombre'],values:[[1,'original']],editContext:{schema:'test',table:'proyectos'}}]};const info=await new ResultEdits().open(snapshot,0,adapter,'mysql','profile');assert.equal(info.columns[0].primary,true);assert.equal(info.columns[0].editable,false);assert.equal(info.columns[1].editable,true);assert.match(info.columns[0].type,/unsigned/);}finally{adapter.close();await server.close();}
});
