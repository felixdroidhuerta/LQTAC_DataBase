const test=require('node:test'),assert=require('node:assert/strict');
const {definitionForDestination,buildComparisonPlan,checkComparisonSnapshot}=require('../src/comparison-edit.cjs');
const base={engine:'mysql',schema:'target',name:'destination',type:'view',definer:'target-user@localhost',sqlMode:''};
test('copy retargets only the header and definer, keeping the body for manual review',()=>{
 const source={...base,schema:'source',name:'origin',definer:'source-user@remote',ddl:'CREATE DEFINER=`source-user`@`remote` SQL SECURITY DEFINER VIEW `source`.`origin` AS SELECT * FROM `source`.`leads`'};
 const text=definitionForDestination(source,base);
 assert.match(text,/DEFINER=`target-user`@`localhost`/);assert.match(text,/VIEW `target`\.`destination`/);assert.match(text,/FROM `source`\.`leads`/);
 const trigger={...base,type:'trigger',body:'SET NEW.id=2'};assert.equal(definitionForDestination(trigger,{...base,type:'trigger'}),'SET NEW.id=2');
 assert.throws(()=>definitionForDestination(trigger,base),/mismo tipo/);
});
test('manual trigger editing keeps destination identity and rejects invalid event or empty body',()=>{
 const original={...base,type:'trigger',table:'leads',timing:'BEFORE',event:'INSERT',body:'SET NEW.id=1'};
 const plan=buildComparisonPlan(original,{text:'BEGIN\n SET NEW.id=3;\nEND',timing:'AFTER',event:'UPDATE',schema:'other',name:'other',table:'other'});
 assert.equal(plan.draft.schema,'target');assert.equal(plan.draft.name,'destination');assert.equal(plan.draft.table,'leads');assert.match(plan.sql,/AFTER UPDATE ON `target`\.`leads`/);
 assert.throws(()=>buildComparisonPlan(original,{text:'',timing:'BEFORE',event:'INSERT'}),/cuerpo SQL/);
 assert.throws(()=>buildComparisonPlan(original,{text:'SET NEW.id=2',timing:'invalid',event:'INSERT'}),/no válido/);
 assert.throws(()=>buildComparisonPlan(original,{text:original.body,timing:original.timing,event:original.event}),/No hay cambios/);
});
test('stale comparison snapshots cannot open a write context',()=>{
 const original={...base,ddl:'CREATE DEFINER=`target-user`@`localhost` VIEW `target`.`destination` AS SELECT 1'};
 assert.doesNotThrow(()=>checkComparisonSnapshot(original,original.ddl));
 assert.throws(()=>checkComparisonSnapshot(original,original.ddl.replace('SELECT 1','SELECT 2')),/ha cambiado/);
 assert.throws(()=>checkComparisonSnapshot(original,''),/captura/);
});
