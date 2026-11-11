const {test}=require('node:test'),assert=require('node:assert/strict');
test('el pegado interpreta tabulaciones, separadores y campos entrecomillados',async()=>{
  const {parseClipboardRows}=await import('../src/renderer/cell-copy.js');
  assert.deepEqual(parseClipboardRows('id\tnombre\r\n1\t"hola\tmundo"'),[['id','nombre'],['1','hola\tmundo']]);
  assert.deepEqual(parseClipboardRows('1;"hola; mundo";"línea 1\nlínea 2"'),[['1','hola; mundo','línea 1\nlínea 2']]);
  assert.deepEqual(parseClipboardRows('1,"hola, ""mundo"""'),[['1','hola, "mundo"']]);
  assert.throws(()=>parseClipboardRows('1;"sin cerrar'),/comillas/);
});
