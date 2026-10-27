const engines=new Set(['mysql','mariadb','postgresql','sqlserver','oracle','sqlite','clickhouse','mongodb']);
function splitSQL(source,engine='mysql',{sqlMode='',lenient=false,batchTSQL=false}={}){
  if(typeof source!=='string'||source.length>1000000)throw new Error('El script debe tener como máximo un millón de caracteres.');if(!engines.has(engine))throw new Error('Motor SQL no válido.');
  if(engine==='mongodb'){if(!source.trim())return [];JSON.parse(source);return [{sql:source.trim(),start:0,end:source.length,line:1}];}
  const result=[];let i=0,start=0,delimiter=';',hasCode=false,words=[],blocks=[],routine=false,incomplete=false,skipQualifier=false,declaring=false,bodyStarted=false;
  function finish(end,sqlEnd=end){const raw=source.slice(start,sqlEnd);if(hasCode){const offset=raw.length-raw.trimStart().length;result.push({sql:raw.trim(),start:start+offset,end,line:source.slice(0,start+offset).split('\n').length,incomplete:incomplete||blocks.length>0||declaring});}start=end;hasCode=false;words=[];blocks=[];routine=false;incomplete=false;skipQualifier=false;declaring=false;bodyStarted=false;}
  function unclosed(message){if(!lenient)throw new Error(message);incomplete=true;i=source.length;}
  function nextWord(offset){const rest=source.slice(offset).replace(/^(?:\s|\/\*[\s\S]*?\*\/|--[^\n]*(?:\n|$))+/,'');return /^([a-zA-Z_]+|;|$)/.exec(rest)?.[1]?.toUpperCase();}
  while(i<source.length){
    if(i===0||source[i-1]==='\n'){
      const line=/^[^\n]*(?:\n|$)/.exec(source.slice(i))[0];
      const directive=['mysql','mariadb'].includes(engine)?/^\s*DELIMITER\s+(\S+)\s*$/i.exec(line):null;
      if(directive){if(hasCode)throw new Error('Termina la sentencia antes de cambiar DELIMITER.');if(directive[1].length>16)throw new Error('DELIMITER demasiado largo.');delimiter=directive[1];i+=line.length;start=i;continue;}
      const separator=engine==='sqlserver'&&/^\s*GO\s*(?:--[^\n]*)?\s*$/i.test(line)||engine==='oracle'&&/^\s*\/\s*$/.test(line);
      if(separator){finish(i);i+=line.length;start=i;continue;}
      if(engine==='sqlserver'&&/^\s*GO\s+\d+/i.test(line))throw new Error('Usa GO sin contador de repeticiones.');
    }
    const c=source[i];if(/\s/.test(c)){i++;continue;}
    if(source.startsWith('--',i)&&(!['mysql','mariadb'].includes(engine)||!source[i+2]||/\s/.test(source[i+2]))||(c==='#'&&['mysql','mariadb','clickhouse'].includes(engine))){const end=source.indexOf('\n',i);i=end<0?source.length:end+1;continue;}
    if(source.startsWith('/*',i)){if(source.startsWith('/*!',i)&&['mysql','mariadb'].includes(engine))hasCode=true;let depth=1;i+=2;while(i<source.length&&depth){if(source.startsWith('/*',i)&&['postgresql','sqlserver'].includes(engine)){depth++;i+=2;}else if(source.startsWith('*/',i)){depth--;i+=2;}else i++;}if(depth)unclosed('Comentario sin cerrar.');continue;}
    const dollar=engine==='postgresql'&&c==='$'?/^\$(?:[a-zA-Z_]\w*)?\$/.exec(source.slice(i))?.[0]:null;
    if(dollar){hasCode=true;const end=source.indexOf(dollar,i+dollar.length);if(end<0)unclosed('Cuerpo dollar-quoted sin cerrar.');else i=end+dollar.length;continue;}
    const alternative=engine==='oracle'?/^q'([\s\S])/i.exec(source.slice(i)):null;
    if(alternative){hasCode=true;const close={'[':']','{':'}','(':')','<':'>'}[alternative[1]]||alternative[1];const end=source.indexOf(close+"'",i+3);if(end<0)unclosed('Cadena Oracle sin cerrar.');else i=end+2;continue;}
    if(["'",'"','`'].includes(c)||(c==='['&&engine==='sqlserver')){
      hasCode=true;const close=c==='['?']':c;const escapes=['mysql','mariadb','clickhouse'].includes(engine)&&!sqlMode.includes('NO_BACKSLASH_ESCAPES')||engine==='postgresql'&&c==="'"&&/[eE]/.test(source[i-1]||'')&&!/[\w$]/.test(source[i-2]||'');let closed=false;i++;
      while(i<source.length){if(escapes&&source[i]==='\\'){i+=2;continue;}if(source[i]===close){if(source[i+1]===close){i+=2;continue;}i++;closed=true;break;}i++;}if(!closed)unclosed('Cadena o identificador sin cerrar.');continue;
    }
    if(source.startsWith(delimiter,i)&&!blocks.length&&!declaring&&!(engine==='oracle'&&routine&&!bodyStarted)&&!(engine==='sqlserver'&&(routine||batchTSQL))){const end=i+delimiter.length;finish(end,delimiter===';'?end:i);i=end;continue;}
    const match=/^[\p{L}_][\p{L}\p{N}_$#]*/u.exec(source.slice(i));
    if(match){let word=match[0];if(delimiter!==';'&&word.includes(delimiter))word=word.slice(0,word.indexOf(delimiter));if(!word){i++;continue;}const upper=word.toUpperCase();hasCode=true;
      if(words.length<18)words.push(upper);if(['CREATE','ALTER'].includes(words[0])&&['PROCEDURE','PROC','FUNCTION','TRIGGER','PACKAGE','EVENT'].includes(upper))routine=true;
      if(engine==='oracle'&&words.length===1&&upper==='DECLARE')declaring=true;
      if(skipQualifier){skipQualifier=false;i+=word.length;continue;}
      if(upper==='CASE')blocks.push('CASE');
      if(upper==='BEGIN'){
        const next=nextWord(i+word.length);
        if(engine==='oracle'||routine||engine==='sqlserver'&&!['TRAN','TRANSACTION','DISTRIBUTED',';',''].includes(next)){blocks.push('BEGIN');declaring=false;bodyStarted=true;}
      }
      if(upper==='END'){
        const wordAfter=nextWord(i+word.length),next=['IF','LOOP','WHILE','REPEAT','CASE'].includes(wordAfter)?wordAfter:null;
        if(next){skipQualifier=true;if(next==='CASE'&&blocks.at(-1)==='CASE')blocks.pop();}else{blocks.pop();bodyStarted=true;}
      }
      i+=word.length;continue;
    }
    if(!source.startsWith(delimiter,i))hasCode=true;i++;
  }
  if(hasCode)finish(source.length);
  if(!lenient&&result.some(item=>item.incomplete))throw new Error('Hay un bloque BEGIN/END o una cadena sin cerrar.');return result;
}
function planExecution(source,options,engine,sqlMode=''){
  if(typeof source!=='string'||source.length>1000000)throw new Error('El script supera el tamaño permitido.');
  if(!options||!['current','selection','all'].includes(options.mode))throw new Error('Modo de ejecución no válido.');
  const cursor=options.cursor??0,start=options.start??cursor,end=options.end??cursor;
  if(![cursor,start,end].every(value=>Number.isInteger(value)&&value>=0&&value<=source.length)||end<start)throw new Error('Posición de consulta no válida.');
  let statements;
  if(options.mode==='selection'){if(start===end)throw new Error('Selecciona el SQL que quieres ejecutar.');statements=splitSQL(source.slice(start,end),engine,{sqlMode,batchTSQL:engine==='sqlserver'});}
  else{const all=splitSQL(source,engine,{sqlMode,lenient:options.mode==='current',batchTSQL:engine==='sqlserver'&&options.mode==='all'});if(options.mode==='all')statements=all;else{const current=all.find(item=>cursor>=item.start&&cursor<=item.end)||all.find(item=>item.start>cursor)||all.at(-1);statements=current?[current]:[];}}
  if(!statements.length)throw new Error('No hay una sentencia para ejecutar.');if(statements.some(item=>item.incomplete))throw new Error('La sentencia del cursor contiene una cadena o bloque sin cerrar.');if(statements.length>100)throw new Error('Ejecuta como máximo 100 sentencias por lanzamiento.');
  return statements;
}
module.exports={splitSQL,planExecution};
