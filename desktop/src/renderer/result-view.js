const collator=new Intl.Collator('es',{numeric:true,sensitivity:'base'});
const searchable=value=>(value==null?'NULL':String(value)).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es');
function decimal(value){
  if(typeof value!=='string'&&typeof value!=='number')return null;
  const match=/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(value).trim());if(!match||!(match[2]||match[3]))return null;
  const exponent=Number(match[4]||0);if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>1000000)return null;
  const digits=(match[2]+(match[3]||'')).replace(/^0+/,'');return {sign:digits?(match[1]==='-'?-1:1):0,digits,magnitude:digits.length+exponent-(match[3]?.length||0)};
}
export function compareCells(left,right){
  const a=decimal(left),b=decimal(right);
  if(a&&b){if(a.sign!==b.sign)return a.sign-b.sign;if(!a.sign)return 0;const length=Math.max(a.digits.length,b.digits.length);const comparison=a.magnitude-b.magnitude||a.digits.padEnd(length,'0').localeCompare(b.digits.padEnd(length,'0'));return a.sign*comparison;}
  return collator.compare(String(left),String(right));
}
export function resultRowIndices(result,{field=-1,search='',sortColumn=null,direction=null}={}){
  const term=searchable(search);const indices=[];
  result.values.forEach((row,index)=>{if(!term||(field<0?row.some(value=>searchable(value).includes(term)):searchable(row[field]).includes(term)))indices.push(index);});
  if(sortColumn!==null&&['asc','desc'].includes(direction))indices.sort((a,b)=>{const left=result.values[a][sortColumn],right=result.values[b][sortColumn];if(left==null||right==null)return left==null&&right==null?a-b:left==null?1:-1;return compareCells(left,right)*(direction==='asc'?1:-1)||a-b;});
  return indices;
}
