const {test}=require('node:test');const assert=require('node:assert/strict');
const {SQLiteAdapter}=require('../src/adapters/sqlite.cjs');const {MySQLAdapter}=require('../src/adapters/mysql.cjs');const {startMySQLFixture}=require('./mysql-fixture.cjs');
const {readColumns}=require('../src/column-metadata.cjs');const {inspectObject,buildObjectPlan,applyObject,routineGrants}=require('../src/object-editor.cjs');
test('column completion resolves aliases, joins, following FROM, selected database, quotes and statement scope',async()=>{
  const {tokensBefore}=await import('../src/renderer/autocomplete.js');const {columnCompletions,tableSources}=await import('../src/renderer/column-completion.js');
  const connection={engine:'mysql',database:'test',schemas:[{name:'test',objects:[{name:'proyectos',type:'table'},{name:'tareas',type:'table'}]},{name:'other',objects:[{name:'proyectos',type:'table'}]}]};const cache=new Map([[JSON.stringify(['test','proyectos']),{columns:[{name:'id',dataType:'int'},{name:'nombre',dataType:'varchar'}]}],[JSON.stringify(['test','tareas']),{columns:[{name:'id',dataType:'int'},{name:'titulo',dataType:'varchar'}]}]]);
  let sql='SELECT p.no FROM proyectos AS p';let cursor=sql.indexOf('no')+2;let result=columnCompletions(sql,cursor,connection,cache,tokensBefore);assert.equal(result.items[0].insert,'`nombre`');assert.equal(result.items[0].from,sql.indexOf('no'));
  sql='SELECT p. FROM proyectos p JOIN tareas t ON p.id=t.id';cursor=sql.indexOf('p.')+2;assert.deepEqual(columnCompletions(sql,cursor,connection,cache,tokensBefore).items.map(item=>item.name),['id','nombre']);
  sql='SELECT i FROM proyectos p JOIN tareas t ON p.id=t.id';assert.deepEqual(columnCompletions(sql,8,connection,cache,tokensBefore).items.map(item=>item.insert).sort(),['`p`.`id`','`t`.`id`']);
  sql='SELECT * FROM proyectos p WHERE no';assert.equal(columnCompletions(sql,sql.length,connection,cache,tokensBefore).items[0].name,'nombre');
  sql='SELECT * FROM tareas t; SELECT p. FROM proyectos p';assert.deepEqual(tableSources(sql,sql.indexOf('p.')+2,connection,tokensBefore).map(item=>item.name),['proyectos']);
  sql="SELECT 'p.no FROM proyectos p";assert.equal(columnCompletions(sql,sql.length,connection,cache,tokensBefore).items.length,0);
  sql='WITH proyectos AS (SELECT 1 AS x) SELECT p. FROM proyectos p';assert.equal(tableSources(sql,sql.indexOf('p.')+2,connection,tokensBefore).length,0);
  sql='SELECT p. FROM other.proyectos p';assert.equal(tableSources(sql,sql.indexOf('p.')+2,connection,tokensBefore)[0].schema,'other');
});
test('SQLite metadata uses declared columns and view edits roll back on invalid DDL',async()=>{
  const adapter=await SQLiteAdapter.open();try{adapter.execute('CREATE TABLE proyectos(id INTEGER,nombre TEXT);CREATE VIEW vista AS SELECT id FROM proyectos;');const schemas=[{name:'main',objects:adapter.schema()}];assert.deepEqual((await readColumns(adapter,'sqlite',[{schema:'main',name:'proyectos'}],schemas))[0].columns.map(item=>item.name),['id','nombre']);await assert.rejects(readColumns(adapter,'sqlite',[{schema:'main',name:'unknown'}],schemas),/catálogo/);
    const original=await inspectObject(adapter,'sqlite',{schema:'main',name:'vista',type:'view'});const plan=buildObjectPlan(original,original.ddl.replace('SELECT id','SELECT id,nombre'));assert.equal((await applyObject(adapter,original,plan)).applied,true);assert.equal(adapter.execute('SELECT * FROM vista').results[0].columns.length,2);
    const current=await inspectObject(adapter,'sqlite',original);const invalid=buildObjectPlan(current,'CREATE VIEW "main"."vista" AS SELECT !!!');await assert.rejects(applyObject(adapter,current,invalid));assert.match((await inspectObject(adapter,'sqlite',original)).ddl,/nombre/);
    assert.throws(()=>buildObjectPlan(original,'CREATE VIEW "main"."otro" AS SELECT 1'),/conservar/);assert.throws(()=>buildObjectPlan(original,'CREATE VIEW vista AS SELECT 1; DROP TABLE proyectos;'),/adicionales/);
  }finally{adapter.close();}
});
test('MySQL actual driver reads/edit views and routine bodies, preserving grants and restoring after CREATE failure',async()=>{
  const fixture=await startMySQLFixture();let adapter;try{adapter=await MySQLAdapter.open(fixture.profile,'fixture');const catalog=await adapter.catalog();assert.equal((await readColumns(adapter,'mysql',[{schema:'test',name:'proyectos'}],catalog.schemas))[0].columns[1].name,'nombre');
    const view=await inspectObject(adapter,'mysql',{schema:'test',name:'vista',type:'view'});const plan=buildObjectPlan(view,view.ddl.replace('SELECT id,nombre','SELECT id'));assert.match(plan.sql,/CREATE OR REPLACE ALGORITHM/);await applyObject(adapter,view,plan);assert.doesNotMatch((await inspectObject(adapter,'mysql',view)).ddl,/id,nombre/);
    for(const [type,name] of [['procedure','actualizar'],['function','calcular']]){const original=await inspectObject(adapter,'mysql',{schema:'test',name,type});assert.equal(original.definer,'fixture@localhost');const plan=buildObjectPlan(original,original.ddl.replace(type==='procedure'?'SELECT 1':'RETURN n+1',type==='procedure'?'SELECT 2':'RETURN n+2'));plan.grants=await routineGrants(adapter,original);assert.match(plan.grants[0],/GRANT EXECUTE, ALTER ROUTINE/);assert.equal((await applyObject(adapter,original,plan)).applied,true);const updated=await inspectObject(adapter,'mysql',original);assert.match(updated.ddl,type==='procedure'?/SELECT 2/:/n\+2/);const bad=buildObjectPlan(updated,updated.ddl+' INVALID_BODY');bad.grants=plan.grants;const failed=await applyObject(adapter,updated,bad);assert.equal(failed.restored,true);assert.equal((await inspectObject(adapter,'mysql',original)).ddl,updated.ddl);}
  }finally{adapter?.close();await fixture.close();}
});
test('native DDL plans retain identity and PostgreSQL signatures, and do not issue CREATE under another name',()=>{
  const postgres={engine:'postgresql',schema:'public',name:'calc',type:'function',ddl:'CREATE FUNCTION public.calc(n integer) RETURNS integer LANGUAGE sql AS $$ SELECT n+1; $$'};
  assert.match(buildObjectPlan(postgres,postgres.ddl.replace('n+1','n+2')).sql,/CREATE OR REPLACE FUNCTION/);assert.throws(()=>buildObjectPlan(postgres,postgres.ddl.replace('n integer','n bigint')),/firma/);assert.throws(()=>buildObjectPlan(postgres,postgres.ddl+'; DROP TABLE p'),/sola definición/);
  const sqlserver={engine:'sqlserver',schema:'dbo',name:'p',type:'procedure',ddl:'CREATE PROCEDURE dbo.p AS BEGIN SELECT 1; END;'};assert.match(buildObjectPlan(sqlserver,sqlserver.ddl).sql,/^ALTER PROCEDURE \[dbo\]\.\[p\]/);
  const oracle={engine:'oracle',schema:'HR',name:'CALC',type:'function',ddl:'CREATE OR REPLACE FUNCTION HR.CALC RETURN NUMBER AS BEGIN RETURN 1; END;'};assert.match(buildObjectPlan(oracle,oracle.ddl).sql,/CREATE OR REPLACE FUNCTION/);
});
