import {quoteIdentifier} from './dialect.js';
// This lexer is shared with table completion so quoted names, comments and literals agree.
const reserved=new Set('SELECT FROM JOIN LEFT RIGHT INNER OUTER FULL CROSS NATURAL WHERE ON USING GROUP ORDER BY HAVING LIMIT OFFSET FETCH UNION EXCEPT INTERSECT SET VALUES RETURNING AND OR AS INTO UPDATE DELETE INSERT FOR WINDOW QUALIFY'.split(' '));
const equal=(a,b)=>a?.toLocaleLowerCase()===b?.toLocaleLowerCase();
export function tableSources(sql,cursor,connection,lex){
  const all=lex(sql,sql.length,connection.engine)||lex(sql,cursor,connection.engine)||[];
  const start=[...all].reverse().find(token=>token.kind===';'&&token.start<cursor)?.end||0;
  const end=all.find(token=>token.kind===';'&&token.start>=cursor)?.start||sql.length;
  const tokens=all.filter(token=>token.start>=start&&token.start<end);let path=[];let cursorPath=[];
  for(const token of tokens){if(token.start<=cursor)cursorPath=[...path];token.path=[...path];if(token.kind==='(')path.push(token.start);if(token.kind===')')path.pop();}
  const sources=[];const fromPaths=new Set();const ctes=new Set();
  if(tokens[0]?.value?.toUpperCase()==='WITH')for(let i=1;i<tokens.length-2;i++){const token=tokens[i];if(token.path.length===0&&token.kind==='identifier'&&tokens[i+1]?.value?.toUpperCase()==='AS'&&tokens[i+2]?.kind==='(')ctes.add(token.value.toLocaleLowerCase());}
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i],upper=token.quote?'':token.value?.toUpperCase(),scope=JSON.stringify(token.path);
    if(['WHERE','GROUP','ORDER','HAVING','UNION','RETURNING','SET','VALUES'].includes(upper))fromPaths.delete(scope);
    const begins=['FROM','JOIN','UPDATE','INTO'].includes(upper)||(token.kind===','&&fromPaths.has(scope));
    if(!begins)continue;if(['FROM','JOIN'].includes(upper))fromPaths.add(scope);
    if(token.path.length>cursorPath.length||token.path.some((value,index)=>cursorPath[index]!==value))continue;
    let name=tokens[i+1];if(name?.kind!=='identifier')continue;let schema=connection.database,alias,next=i+2;const qualified=tokens[next]?.kind==='.';
    if(qualified){schema=name.value;name=tokens[next+1];next+=2;}if(name?.kind!=='identifier'||(!qualified&&ctes.has(name.value.toLocaleLowerCase())))continue;
    if(tokens[next]?.value?.toUpperCase()==='AS')next++;
    const candidate=tokens[next];if(candidate?.kind==='identifier'&&(candidate.quote||!reserved.has(candidate.value.toUpperCase())))alias=candidate.value;
    const sensitive=['postgresql','oracle'].includes(connection.engine);const fold=value=>connection.engine==='postgresql'?value.toLowerCase():connection.engine==='oracle'?value.toUpperCase():value;
    if(qualified&&!tokens[i+1].quote)schema=fold(schema);const expected=name.quote?name.value:fold(name.value);
    const catalog=connection.schemas?.find(item=>item.name===schema)||(!sensitive&&connection.schemas?.find(item=>equal(item.name,schema)));const object=catalog?.objects.find(item=>item.name===expected&&['table','view'].includes(item.type))||(!sensitive&&catalog?.objects.find(item=>equal(item.name,expected)&&['table','view'].includes(item.type)));
    if(object)sources.push({schema:catalog.name,name:object.name,alias:alias||name.value,depth:token.path.length});
  }
  return sources.sort((a,b)=>b.depth-a.depth).filter((item,index,list)=>list.findIndex(other=>equal(other.alias,item.alias))===index).slice(0,8);
}
export function columnCompletions(sql,cursor,connection,cache,lex,force=false){
  if(!connection||connection.engine==='mongodb')return {items:[],sources:[]};const before=lex(sql,cursor,connection.engine);if(!before)return {items:[],sources:[]};
  const tokens=[...before],last=tokens.at(-1),fragment=last?.kind==='identifier'&&last.end===cursor?tokens.pop():null;
  let qualifier=null;if(tokens.at(-1)?.kind==='.'){tokens.pop();qualifier=tokens.pop()?.value;}
  const context=tokens.at(-1)?.value?.toUpperCase();if(['FROM','JOIN','INTO','UPDATE','TABLE','TRUNCATE'].includes(context))return {items:[],sources:[]};
  let sources=tableSources(sql,cursor,connection,lex);if(qualifier)sources=sources.filter(item=>equal(item.alias,qualifier)||equal(item.name,qualifier));
  const prefix=fragment?.value||'';if(!force&&!qualifier&&!prefix)return {items:[],sources};
  if(!qualifier&&!force&&prefix.length<1)return {items:[],sources};
  const from=fragment?.start??cursor;let to=cursor;
  if(fragment?.quote&&sql[cursor-1]!==fragment.quote){while(to<sql.length){if(sql[to]===fragment.quote){if(sql[to+1]===fragment.quote){to+=2;continue;}to++;break;}to++;}}
  else if(!fragment?.quote)while(/[\p{L}\p{N}_$]/u.test(sql[to]||' ')&&to<sql.length)to++;
  const items=[];for(const source of sources){const metadata=cache.get(JSON.stringify([source.schema,source.name]));for(const column of metadata?.columns||[]){if(!column.name.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()))continue;const quote=value=>quoteIdentifier(value,connection.engine);items.push({name:column.name,schema:`${source.alias} · ${column.dataType}`,type:'column',from,to,insert:!qualifier&&sources.length>1?quote(source.alias)+'.'+quote(column.name):quote(column.name),rank:source.depth});}}
  return {items:items.sort((a,b)=>a.name.localeCompare(b.name)||a.schema.localeCompare(b.schema)).slice(0,30),sources};
}
