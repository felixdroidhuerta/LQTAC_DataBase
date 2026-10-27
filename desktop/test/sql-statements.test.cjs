const {test}=require('node:test');const assert=require('node:assert/strict');const {splitSQL,planExecution}=require('../src/sql-statements.cjs');
test('cursor executes one multi-line SQL statement, selection takes precedence and trailing drafts do not block an earlier statement',()=>{
  const source='-- uno\nSELECT\n  1 AS uno\nFROM tabla;\n\n-- dos\nSELECT 2 AS dos;';const current=planExecution(source,{mode:'current',cursor:source.indexOf('2 AS')},'mysql');assert.equal(current.length,1);assert.match(current[0].sql,/SELECT 2/);assert.doesNotMatch(current[0].sql,/1 AS/);
  assert.match(planExecution(source,{mode:'current',cursor:source.indexOf('FROM')},'mysql')[0].sql,/1 AS uno/);
  assert.match(planExecution(source,{mode:'selection',cursor:0,start:source.indexOf('SELECT 2'),end:source.length},'mysql')[0].sql,/^SELECT 2/);
  assert.equal(planExecution("SELECT 1; SELECT 'draft",{mode:'current',cursor:3},'mysql').length,1);assert.throws(()=>planExecution("SELECT 1; SELECT 'draft",{mode:'all'},'mysql'),/sin cerrar/);
});
test('SQL splitter ignores separators in literals, identifiers, comments, dollar bodies and Oracle quoted strings',()=>{
  assert.equal(splitSQL("SELECT ';', `a;b`; /* ; */ SELECT 'it''s; fine'; -- end",'mysql').length,2);
  assert.equal(splitSQL("CREATE FUNCTION f() RETURNS text AS $$ SELECT ';'; $$ LANGUAGE sql; SELECT 2;",'postgresql').length,2);
  assert.equal(splitSQL("SELECT q'[a';b]' FROM DUAL; SELECT 2 FROM DUAL;",'oracle').length,2);
  assert.equal(splitSQL('SELECT 1 /* outer /* inner; */ comment */; SELECT 2;','postgresql').length,2);
  assert.equal(splitSQL('/*!40101 SET @x=1 */; SELECT @x;','mysql').length,2);
});
test('compound routines, custom MySQL delimiters, Oracle anonymous declarations and SQL Server GO stay complete',()=>{
  const mysql="DELIMITER $$\nCREATE PROCEDURE p() BEGIN IF 1 THEN SELECT ';'; END /* note */ IF; SELECT 2; END$$\nDELIMITER ;\nSELECT 3;";const parts=splitSQL(mysql,'mysql');assert.equal(parts.length,2);assert.doesNotMatch(parts[0].sql,/DELIMITER|END\$\$/);assert.match(parts[0].sql,/END$/);
  assert.equal(splitSQL('CREATE TRIGGER t AFTER INSERT ON x BEGIN INSERT INTO y VALUES(1); INSERT INTO y VALUES(2); END; SELECT 1;','sqlite').length,2);
  assert.equal(splitSQL('DECLARE n NUMBER; BEGIN n:=1; IF n=1 THEN n:=2; END IF; END;\n/\nSELECT 1 FROM DUAL;','oracle').length,2);
  const sqlserver='CREATE PROCEDURE dbo.p AS BEGIN SELECT 1; SELECT 2; END;\nGO\nSELECT 3;';assert.equal(splitSQL(sqlserver,'sqlserver').length,2);
  const batch='DECLARE @n int; SET @n=2; SELECT @n; SELECT 3;\nGO\nSELECT 4;';assert.equal(planExecution(batch,{mode:'all'},'sqlserver').length,2);assert.equal(planExecution('SELECT 1; SELECT 2;',{mode:'current',cursor:16},'sqlserver').length,1);
  assert.throws(()=>planExecution('SELECT 1;'.repeat(101),{mode:'all'},'mysql'),/100/);
});
