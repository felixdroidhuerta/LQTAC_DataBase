import {FUNCTION_SPECS,toNumber,bounded,truth,compare,callFunction} from './dashboard-functions.mjs';
export {FUNCTION_CATALOG} from './dashboard-functions.mjs';export const asNumber=toNumber;
const NUMBER=/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/i;
export function parseFormula(expression,fieldCount,mode='row'){
 if(typeof expression!=='string'||!expression.trim()||expression.length>2000)throw Error('Escribe una fórmula de hasta 2000 caracteres.');
 const tokens=[];let pos=0;while(pos<expression.length){const s=expression.slice(pos);if(/^\s/.test(s)){pos++;continue;}let m;
 if(s[0]==="'"||s[0]==='"'){const quote=s[0];let value='',closed=false;pos++;while(pos<expression.length){const c=expression[pos++];if(c===quote){if(expression[pos]===quote){value+=quote;pos++;}else{closed=true;break;}}else if(c==='\\'){const next=expression[pos++],map={n:'\n',r:'\r',t:'\t',"'":"'",'"':'"','\\':'\\'};if(!Object.hasOwn(map,next))throw Error('Escape de texto no admitido. Usa comillas duplicadas para incluir una comilla.');value+=map[next];}else value+=c;}if(!closed)throw Error('Texto sin cerrar: revisa las comillas.');tokens.push({type:'string',value});}
 else if((m=/^\[(\d+)\]/.exec(s))){const index=Number(m[1]);if(index>=fieldCount)throw Error('La fórmula referencia un campo que no existe.');tokens.push({type:'field',value:index});pos+=m[0].length;}
 else if((m=NUMBER.exec(s))){const value=Number(m[0]);if(!Number.isFinite(value))throw Error('Número fuera de rango.');tokens.push({type:'number',value});pos+=m[0].length;}
 else if((m=/^[A-Za-z_][A-Za-z_0-9]*/.exec(s))){tokens.push({type:'name',value:m[0].toUpperCase()});pos+=m[0].length;}
 else if((m=/^(?:>=|<=|<>|!=|[+\-*/%(),=<>])/.exec(s))){tokens.push({type:m[0]});pos+=m[0].length;}else throw Error('Símbolo no permitido. Usa campos [0], texto entre comillas y funciones del catálogo.');if(tokens.length>512)throw Error('La fórmula es demasiado compleja.');}
 let i=0,depth=0;const peek=()=>tokens[i]?.type,isName=n=>peek()==='name'&&tokens[i].value===n,take=t=>{if(peek()!==t)throw Error('Revisa los paréntesis y argumentos de la fórmula.');return tokens[i++];};
 function atom(){if(++depth>32)throw Error('Demasiados niveles de paréntesis.');let out;
 if(peek()==='+'||peek()==='-'){const op=tokens[i++].type;out={kind:'unary',op,arg:atom()};}
 else if(peek()==='number'||peek()==='string'){const token=tokens[i++];out={kind:'literal',value:token.value};}
 else if(peek()==='field'){if(mode==='measure')throw Error('En una medida usa SUM([0]), AVG([0]) o COUNT(), no un campo sin agregar.');out={kind:'field',index:tokens[i++].value};}
 else if(peek()==='('){i++;out=expr();take(')');}
 else if(peek()==='name'){const name=tokens[i++].value;if(['NULL','TRUE','FALSE'].includes(name))out={kind:'literal',value:name==='NULL'?null:name==='TRUE'};else{take('(');if(['SUM','AVG','COUNT','MIN','MAX','DISTINCT'].includes(name)){if(mode!=='measure')throw Error('Las agregaciones solo se usan en medidas.');let field=null;if(peek()!==')')field=take('field').value;take(')');if(name!=='COUNT'&&field===null)throw Error(name+' necesita un campo.');out={kind:'aggregate',name,index:field};}else{const spec=FUNCTION_SPECS.get(name);if(!spec)throw Error('Función no admitida: '+name);const args=[];if(peek()!==')'){args.push(expr());while(peek()===','){i++;args.push(expr());}}take(')');if(args.length<spec.min||args.length>spec.max)throw Error('Número de argumentos incorrecto para '+name+'.');out={kind:'call',name,args};}}}
 else throw Error('La fórmula está incompleta.');depth--;return out;}
 function product(){let out=atom();while(['*','/','%'].includes(peek())){const op=tokens[i++].type;out={kind:'binary',op,left:out,right:atom()};}return out;}
 function sum(){let out=product();while(['+','-'].includes(peek())){const op=tokens[i++].type;out={kind:'binary',op,left:out,right:product()};}return out;}
 function comparison(){let out=sum();while(['=','!=','<>','<','>','<=','>='].includes(peek())){const op=tokens[i++].type;out={kind:'compare',op,left:out,right:sum()};}if(isName('IS')){i++;let negative=false;if(isName('NOT')){i++;negative=true;}if(!isName('NULL'))throw Error('Usa IS NULL o IS NOT NULL.');i++;out={kind:'isnull',arg:out,negative};}return out;}
 function not(){if(isName('NOT')){i++;return {kind:'not',arg:not()};}return comparison();}
 function and(){let out=not();while(isName('AND')){i++;out={kind:'logical',op:'AND',left:out,right:not()};}return out;}
 function expr(){let out=and();while(isName('OR')){i++;out={kind:'logical',op:'OR',left:out,right:and()};}return out;}
 const ast=expr();if(i!==tokens.length)throw Error('Hay texto adicional en la fórmula. Usa referencias [n] para los campos.');return ast;
}
export function aggregate(rows,column,operation){if(operation==='count')return column===null?rows.length:rows.filter(r=>r[column]!==null).length;if(operation==='distinct')return new Set(rows.filter(r=>r[column]!==null).map(r=>JSON.stringify([typeof r[column],r[column]]))).size;let sum=0,n=0,lo=Infinity,hi=-Infinity;for(const row of rows){const v=asNumber(row[column]);if(v===null)continue;sum+=v;n++;lo=Math.min(lo,v);hi=Math.max(hi,v);}if(!n)return null;const result=operation==='sum'?sum:operation==='avg'?sum/n:operation==='min'?lo:hi;if(!Number.isFinite(result))throw Error('La medida supera el rango numérico.');return result;}

export function evaluateFormula(ast,{row,rows}={}){const run=node=>{
 if(node.kind==='literal'||node.kind==='number')return node.value;if(node.kind==='field')return row[node.index]??null;if(node.kind==='aggregate')return aggregate(rows,node.index,node.name.toLowerCase());
 if(node.kind==='unary'){const n=asNumber(run(node.arg));return n===null?null:node.op==='-'?-n:n;}
 if(node.kind==='not'){const value=truth(run(node.arg));return value===null?null:!value;}if(node.kind==='isnull'){const isnull=run(node.arg)==null;return node.negative?!isnull:isnull;}
 if(node.kind==='compare'){const c=compare(run(node.left),run(node.right));return c===null?null:node.op==='='?c===0:node.op==='!='||node.op==='<>'?c!==0:node.op==='<'?c<0:node.op==='>'?c>0:node.op==='<='?c<=0:c>=0;}
 if(node.kind==='logical'){const a=truth(run(node.left));if(node.op==='AND'&&a===false)return false;if(node.op==='OR'&&a===true)return true;const b=truth(run(node.right));return node.op==='AND'?(b===false?false:a===null||b===null?null:true):(b===true?true:a===null||b===null?null:false);}
 if(node.kind==='call'){if(node.name==='COALESCE'){for(const arg of node.args){const value=run(arg);if(value!==null&&value!==undefined)return value;}return null;}if(node.name==='IFNULL'){const a=run(node.args[0]);return a==null?run(node.args[1]):a;}if(node.name==='NULLIF'){const a=run(node.args[0]);return compare(a,run(node.args[1]))===0?null:a;}if(node.name==='IF')return run(node.args[truth(run(node.args[0]))?1:2]);if(node.name==='ISNULL')return run(node.args[0])==null?1:0;return bounded(callFunction(node.name,node.args.map(run)));}
 const a=asNumber(run(node.left)),b=asNumber(run(node.right));if(a===null||b===null||['/','%'].includes(node.op)&&b===0)return null;return bounded(node.op==='+'?a+b:node.op==='-'?a-b:node.op==='*'?a*b:node.op==='%'?a%b:a/b);
 };return bounded(run(ast));}
export function recalculateColumns(dataset){let bytes=0;const encoder=new TextEncoder();for(const c of dataset.calculations||[]){const ast=parseFormula(c.expression,c.index,'row');for(const row of dataset.rows){const value=evaluateFormula(ast,{row});bytes+=typeof value==='string'?encoder.encode(value).length:8;if(bytes>20000000)throw Error('Las columnas calculadas superan 20 MB. Reduce las filas o el texto generado.');row[c.index]=value;}}return dataset;}
