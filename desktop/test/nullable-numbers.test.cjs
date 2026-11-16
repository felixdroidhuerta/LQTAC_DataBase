const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalize}=require('../src/result-edit.cjs');
test('celdas numéricas vacías admiten NULL solo en columnas nullable',()=>{
  for(const engine of ['mysql','mariadb','postgresql','sqlite']){
    for(const type of ['int','bigint unsigned','numeric(12,2)','double precision']){
      const column={name:'valor',type,nullable:true};
      assert.equal(normalize('',column,engine),null);
      assert.equal(normalize('  ',column,engine),null);
      assert.equal(normalize(null,column,engine),null);
      assert.equal(normalize('NULL',column,engine),null);
      assert.equal(normalize(' null ',column,engine),null);
      assert.throws(()=>normalize('',{...column,nullable:false},engine),/requiere/);
      assert.throws(()=>normalize('abc',column,engine),/requiere/);
    }
  }
  for(const type of ['varchar(20)','text','date','datetime','boolean','uuid']){
    assert.equal(normalize('',{name:'campo',type,nullable:true},'mysql'),null);
    assert.equal(normalize(null,{name:'campo',type,nullable:true},'mysql'),null);
    assert.throws(()=>normalize(null,{name:'campo',type,nullable:false},'mysql'),/no admite NULL/);
  }
  assert.equal(normalize(' ',{name:'texto',type:'varchar(20)',nullable:true},'mysql'),' ');
});
