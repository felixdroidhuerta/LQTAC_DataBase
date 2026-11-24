const test=require('node:test'),assert=require('node:assert/strict');
const model=()=>import('../src/renderer/schema-diff.mjs');
const opts={ignoreWhitespace:true,ignoreDefiner:true,ignoreSchema:true,ignoreComments:true};
const item=(ddl,schema='a')=>({ddl,schema,name:'v',type:'view',sqlMode:''});
test('normalization ignores selected noise without changing strings, executable comments, or SQL mode',async()=>{
 const {normalizedDDL,compareObjects}=await model();
 const a=item("CREATE DEFINER=`one`@`localhost` VIEW `a`.`v` AS SELECT 'a.b  c' AS x; -- comment");
 const b=item("CREATE DEFINER=`two`@`host` VIEW `b`.`v`\nAS SELECT 'a.b  c' AS x;",'b');
 assert.equal(normalizedDDL(a,opts),normalizedDDL(b,opts));
 assert.notEqual(normalizedDDL(a,{}),normalizedDDL(b,{}));
 assert.notEqual(normalizedDDL(a,opts),normalizedDDL({...b,ddl:b.ddl.replace('a.b  c','a.b c')},opts));
 assert.notEqual(normalizedDDL(item('SELECT /*! STRAIGHT_JOIN */ 1'),opts),normalizedDDL(item('SELECT 1'),opts));
 assert.equal(compareObjects([a],[b],opts)[0].status,'equal');
 assert.equal(compareObjects([a],[{...b,sqlMode:'ANSI_QUOTES'}],opts)[0].status,'modified');
 assert.equal(compareObjects([a],[{...b,error:'No permission'}],opts)[0].status,'error');
 assert.equal(compareObjects([a],[],opts)[0].status,'only-a');assert.equal(compareObjects([],[a],opts)[0].status,'only-b');
 assert.equal(compareObjects([a],[{...a,type:'function'}],opts).length,2);
});
test('line alignment preserves every line and identifies additions, removals and modifications',async()=>{
 const {diffLines}=await model();
 const rows=diffLines('a\nb\nc','a\nx\nc\nd');
 assert.deepEqual(rows.map(r=>r.kind),['equal','modified','equal','added']);
 assert.deepEqual(rows.filter(r=>r.a!==null).map(r=>r.left),['a','b','c']);
 assert.deepEqual(rows.filter(r=>r.b!==null).map(r=>r.right),['a','x','c','d']);
 assert.deepEqual(diffLines('x','').map(r=>r.kind),['removed']);assert.deepEqual(diffLines('','x').map(r=>r.kind),['added']);
 const largeA=Array.from({length:1500},(_,i)=>'a'+i).join('\n'),largeB=largeA.replaceAll('a','b'),large=diffLines(largeA,largeB);
 assert.equal(large.length,1500);assert.equal(large[1499].left,'a1499');assert.equal(large[1499].right,'b1499');
});
test('backend uses metadata reads and quotes identifiers, retaining permission errors',async()=>{
 const {readDefinitions}=require('../src/schema-compare.cjs');const queries=[];
 const adapter={alive:true,connection:{promise:()=>({query:async request=>{
  queries.push(request);const fields=names=>names.map(name=>({name}));
  if(request.sql.startsWith('SELECT @@'))return [[['STRICT_TRANS_TABLES']],fields(['sql_mode'])];
  if(request.sql.includes('TRIGGER_NAME AS name'))return [[['t`x','db','leads']],fields(['name','table_schema','table_name'])];
  if(request.sql.includes('TABLE_NAME AS name'))return [[['denied']],fields(['name'])];
  if(request.sql.includes('ROUTINE_NAME AS name'))return [[],fields(['name','kind'])];
  if(request.sql.startsWith('SHOW CREATE TRIGGER'))return [[['CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET NEW.id=1']],fields(['SQL Original Statement'])];
  throw Error('No permission');
 }})}};
 const result=await readDefinitions(adapter,'db');assert.equal(result.objects.length,2);assert.equal(result.objects[1].error,'No permission');
 assert.equal(result.objects[0].table,'leads');assert.equal(result.objects[0].tableSchema,'db');
 assert.ok(queries.some(q=>q.sql==='SHOW CREATE TRIGGER `db`.`t``x`'));assert.ok(queries.every(q=>/^(SELECT|SHOW) /.test(q.sql)));
 assert.ok(queries.some(q=>q.values[0]==='db'));await assert.rejects(readDefinitions(adapter,'bad\nname'),/no válido/);
});
