const {test}=require('node:test');const assert=require('node:assert/strict');const {exportRows}=require('../src/query-tools.cjs');
test('result sorting handles numeric strings exactly, negative decimals, stable equal keys and NULL last',async()=>{
  const {resultRowIndices,compareCells}=await import('../src/renderer/result-view.js');
  const result={columns:['n'],values:[['9007199254740993'],['2'],[null],['10'],['9007199254740992'],['-0.2'],['-10'],['2.00']]};
  const ascending=resultRowIndices(result,{sortColumn:0,direction:'asc'});assert.deepEqual(ascending,[6,5,1,7,3,4,0,2]);
  assert.equal(resultRowIndices(result,{sortColumn:0,direction:'desc'}).at(-1),2);assert.deepEqual(resultRowIndices(result),[0,1,2,3,4,5,6,7]);
  assert.equal(compareCells('0.001','1e-3'),0);assert.ok(compareCells('-1.20','-1.19')<0);assert.ok(compareCells('2026-10-01','2026-09-30')>0);assert.equal(result.values[0][0],'9007199254740993');
});
test('field and global substring filtering ignores accents/case, treats search as text and preserves duplicate column indices',async()=>{
  const {resultRowIndices}=await import('../src/renderer/result-view.js');const result={columns:['nombre','nombre','nota'],values:[['José','otro',null],['Ana','José','100%'],['JOSEFA','x','']]};
  assert.deepEqual(resultRowIndices(result,{field:0,search:'jose'}),[0,2]);assert.deepEqual(resultRowIndices(result,{field:1,search:'jose'}),[1]);assert.deepEqual(resultRowIndices(result,{search:'jose'}),[0,1,2]);assert.deepEqual(resultRowIndices(result,{field:2,search:'%'}),[1]);assert.deepEqual(resultRowIndices(result,{field:2,search:'NULL'}),[0]);assert.deepEqual(resultRowIndices(result,{search:'not-present'}),[]);
});
test('exports use validated row indices from the original snapshot rather than renderer-supplied cell values',()=>{
  const original={columns:['id'],values:[[2],[10],[1]]};assert.deepEqual(exportRows(original,[2,1]).values,[[1],[10]]);assert.deepEqual(exportRows(original,[]).values,[]);assert.deepEqual(original.values,[[2],[10],[1]]);
  for(const indices of [[0,0],[-1],[3],[0.1],['0'],null])assert.throws(()=>exportRows(original,indices),/no es válida/);
});
