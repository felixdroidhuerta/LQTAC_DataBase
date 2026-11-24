const {identifier}=require('./mysql-table.cjs');
const {inspectTrigger,createTriggerSQL}=require('./mysql-trigger.cjs');
const {inspectObject,header,normalizeDDL,buildObjectPlan}=require('./object-editor.cjs');
async function inspectComparisonObject(worker,engine,target){
 if(target.type==='trigger')return {...await inspectTrigger(worker,target.schema,target.name),engine,type:'trigger'};
 return inspectObject(worker,engine,target);
}
function checkComparisonSnapshot(original,expected){
 if(typeof expected!=='string'||!expected.trim())throw Error('Falta la captura del objeto. Vuelve a comparar.');
 const normalized=original.type==='trigger'?expected:normalizeDDL(expected,original,'CREATE');
 if(normalized!==original.ddl)throw Error('El objeto ha cambiado desde la comparación. Vuelve a comparar antes de editar.');
 if(original.ddl.length>1000000)throw Error('El editor admite definiciones de hasta un millón de caracteres.');
}
function definitionForDestination(source,destination){
 if(source.type!==destination.type)throw Error('Los dos objetos deben tener el mismo tipo.');
 if(source.type==='trigger')return source.body;
 const parsed=header(source.ddl,source),changes=[{from:parsed.nameStart,to:parsed.nameEnd,text:`${identifier(destination.schema)}.${identifier(destination.name)}`}];
 const def=parsed.list.findIndex((token,index)=>index<parsed.index&&token.value.toUpperCase()==='DEFINER'&&parsed.list[index+1]?.value==='=');
 const account=destination.definer;let clause='';
 if(account){const at=account.lastIndexOf('@');if(at<1)throw Error('No se reconoce el DEFINER de destino.');const quote=value=>'`'+value.replaceAll('`','``')+'`';clause=`DEFINER=${quote(account.slice(0,at))}@${quote(account.slice(at+1))}`;}
 if(def>=0)changes.push({from:parsed.list[def].start,to:parsed.list[def+4].end,text:clause});
 else if(clause)changes.push({from:parsed.prefixEnd,to:parsed.prefixEnd,text:' '+clause});
 let result=source.ddl;for(const change of changes.sort((a,b)=>b.from-a.from))result=result.slice(0,change.from)+change.text+result.slice(change.to);
 return result;
}
function buildComparisonPlan(original,request){
 if(original.type==='trigger'){
  const draft={schema:original.schema,table:original.table,name:original.name,timing:request.timing,event:request.event,body:request.text};
  if(['timing','event','body'].every(key=>draft[key]===original[key]))throw Error('No hay cambios en el trigger.');
  const create=createTriggerSQL(draft,original);
  return {draft,sql:`DROP TRIGGER ${identifier(original.schema)}.${identifier(original.name)};\n\n${create}`,warnings:['Se conserva el nombre, la tabla y el DEFINER del destino.','DROP + CREATE no es atómico. Se guardará la definición original y se intentará restaurarla si falla CREATE.']};
 }
 if(request.text===original.ddl)throw Error('No hay cambios en la definición.');
 return buildObjectPlan(original,request.text);
}
function comparisonSnapshot(original){
 return {name:original.name,type:original.type,schema:original.schema,sqlMode:original.sqlMode||'',ddl:original.ddl,error:null,...(original.type==='trigger'?{table:original.table,tableSchema:original.schema}:{})};
}
module.exports={inspectComparisonObject,checkComparisonSnapshot,definitionForDestination,buildComparisonPlan,comparisonSnapshot};
