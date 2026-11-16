const {test}=require('node:test'),assert=require('node:assert/strict');
const {ResultEdits,decorateResult}=require('../src/result-edit.cjs');
function adapterFor({nullable='NO',prefix=null}={}){
 const reply=records=>{const names=Object.keys(records[0]);return [records.map(row=>names.map(name=>row[name])),names.map(name=>({name}))];};
 return {connection:{promise:()=>({query:async sql=>{
  if(sql.startsWith('SHOW CREATE'))return [[],[{name:'Create Table'}]];
  if(sql.startsWith('SHOW INDEX'))return reply([{Key_name:'unique_user',Non_unique:0,Column_name:'usr_id_peer',Sub_part:prefix}]);
  return reply([{Field:'usr_id_peer',Type:'int unsigned',Null:nullable,Extra:'auto_increment',Default:null},{Field:'usr_name',Type:'varchar(255)',Null:'YES',Extra:'',Default:null}]);
 }})}};
}
test('WHERE permite edición y pegado con UNIQUE NOT NULL sin PRIMARY',async()=>{
 const adapter=adapterFor(),result={columns:['usr_id_peer','usr_name'],values:[[9011,'TRANSFER']]};
 decorateResult(result,{sql:'SELECT * FROM usr_users WHERE usr_id_peer=9011',engine:'mysql',database:'crmti',adapter});
 const snapshot={results:[result]},service=new ResultEdits();
 const info=await service.open(snapshot,0,adapter,'mysql','server');
 assert.equal(info.columns[0].primary,true);assert.equal(info.columns[0].auto,true);
 const preview=service.preview({token:info.token,inserts:[{row:1,values:[{column:1,value:'COPY'}]}]},snapshot,adapter,'server');
 assert.match(preview.statements[0],/INSERT INTO `crmti`.`usr_users`/);
 for(const options of [{nullable:'YES'},{prefix:3}])await assert.rejects(new ResultEdits().open(snapshot,0,adapterFor(options),'mysql','server'),/UNIQUE/);
});
