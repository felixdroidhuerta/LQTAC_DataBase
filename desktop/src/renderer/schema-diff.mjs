import {tokenizeSQL} from './sql-highlight.js';
export function normalizedDDL(item,options={}){
 if(!item)return '';
 let tokens=tokenizeSQL(item.ddl||'');
 // Only remove DEFINER in the CREATE header, never occurrences in a stored body.
 if(options.ignoreDefiner){
  const end=tokens.findIndex(t=>t.type==='keyword'&&['TRIGGER','VIEW','PROCEDURE','FUNCTION'].includes(t.text.toUpperCase()));
  const start=tokens.findIndex((t,i)=>i<end&&t.type==='keyword'&&t.text.toUpperCase()==='DEFINER');
  if(start>=0){let i=start+1;while(tokens[i]?.type==='plain')i++;if(tokens[i]?.text==='='){
   i++;while(tokens[i]?.type==='plain')i++;i++;while(tokens[i]?.type==='plain')i++;
   if(tokens[i]?.text==='@'){i++;while(tokens[i]?.type==='plain')i++;i++;}
   tokens=tokens.slice(0,start).concat(tokens.slice(i));
  }}
 }
 if(options.ignoreSchema){let next=null;for(let index=tokens.length-1;index>=0;index--){const token=tokens[index];
  const text=token.text.startsWith('`')?token.text.slice(1,-1).replaceAll('``','`'):token.text;
  if(token.type==='identifier'&&text===item.schema&&next?.text==='.')tokens[index]={...token,text:'<base>'};
  if(token.type!=='plain')next=token;
 }}
 if(options.ignoreComments)tokens=tokens.filter(t=>t.type!=='comment'||/^\/\*[!+]/.test(t.text));
 if(options.ignoreWhitespace)tokens=tokens.filter(t=>t.type!=='plain');
 return JSON.stringify(tokens.map(t=>[t.type,t.text.replace(/\r\n?/g,'\n')]));
}
export function compareObjects(left,right,options={}){
 const key=item=>JSON.stringify([item.type,item.name]);
 const a=new Map(left.map(item=>[key(item),item])),b=new Map(right.map(item=>[key(item),item]));
 return [...new Set([...a.keys(),...b.keys()])].map(id=>{
  const l=a.get(id),r=b.get(id),object=l||r;
  const status=l?.error||r?.error?'error':!l?'only-b':!r?'only-a':normalizedDDL(l,options)===normalizedDDL(r,options)&&l.sqlMode===r.sqlMode?'equal':'modified';
  return {id,name:object.name,type:object.type,status,left:l||null,right:r||null};
 }).sort((a,b)=>a.type.localeCompare(b.type)||a.name.localeCompare(b.name));
}
export function diffLines(left,right){
 const a=left===''?[]:left.replace(/\r\n?/g,'\n').split('\n'),b=right===''?[]:right.replace(/\r\n?/g,'\n').split('\n');
 let prefix=0;while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
 let suffix=0;while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
 const x=a.slice(prefix,a.length-suffix),y=b.slice(prefix,b.length-suffix),ops=[];
 for(let i=0;i<prefix;i++)ops.push({a:i,b:i});
 if(x.length*y.length<=2000000){
  const width=y.length+1,grid=new Uint32Array((x.length+1)*width);
  for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)grid[i*width+j]=x[i]===y[j]?grid[(i+1)*width+j+1]+1:Math.max(grid[(i+1)*width+j],grid[i*width+j+1]);
  let i=0,j=0;while(i<x.length||j<y.length){
   if(i<x.length&&j<y.length&&x[i]===y[j]){ops.push({a:prefix+i++,b:prefix+j++});}
   else if(j===y.length||(i<x.length&&grid[(i+1)*width+j]>=grid[i*width+j+1]))ops.push({a:prefix+i++});
   else ops.push({b:prefix+j++});
  }
 }else{
  // Bound comparison cost for huge changed bodies; preserve every line for inspection.
  for(let i=0;i<x.length;i++)ops.push({a:prefix+i});for(let j=0;j<y.length;j++)ops.push({b:prefix+j});
 }
 for(let i=suffix;i>0;i--)ops.push({a:a.length-i,b:b.length-i});
 const rows=[];
 for(let i=0;i<ops.length;){
  if(ops[i].a!==undefined&&ops[i].b!==undefined){rows.push({left:a[ops[i].a],right:b[ops[i].b],a:ops[i].a+1,b:ops[i].b+1,kind:'equal'});i++;continue;}
  const removed=[],added=[];while(i<ops.length&&(ops[i].a===undefined||ops[i].b===undefined)){const op=ops[i++];if(op.a!==undefined)removed.push(op.a);else added.push(op.b);}
  for(let k=0;k<Math.max(removed.length,added.length);k++){const ai=removed[k],bi=added[k];rows.push({left:ai===undefined?'':a[ai],right:bi===undefined?'':b[bi],a:ai===undefined?null:ai+1,b:bi===undefined?null:bi+1,kind:ai===undefined?'added':bi===undefined?'removed':'modified'});}
 }
 return rows;
}
