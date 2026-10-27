import { quoteIdentifier } from './dialect.js';
import { columnCompletions } from './column-completion.js';
const word = character => !!character && /[\p{L}\p{N}_$]/u.test(character);
const tableContexts = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'TRUNCATE']);

// Read lexical context so names are never suggested inside literals or comments.
export function tokensBefore(sql, cursor, engine) {
  const tokens = [];
  let index = 0;
  while (index < cursor) {
    const start = index;
    const c = sql[index];
    if (/\s/.test(c)) { index++; continue; }
    if (sql.startsWith('--', index) || (c === '#' && ['mysql', 'mariadb', 'clickhouse'].includes(engine))) {
      const end = sql.indexOf('\n', index);
      if (end < 0 || end >= cursor) return null;
      index = end + 1; continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0 || end + 2 > cursor) return null;
      index = end + 2; continue;
    }
    const dollar = engine === 'postgresql' && c === '$' ? /^\$(?:[a-zA-Z_][\w]*)?\$/.exec(sql.slice(index))?.[0] : null;
    if (dollar) { const end = sql.indexOf(dollar, index + dollar.length); if (end < 0 || end + dollar.length > cursor) return null; index = end + dollar.length; tokens.push({ kind: 'literal', start, end: index }); continue; }
    if (c === "'") {
      index++;
      let closed = false;
      while (index < cursor) {
        if (sql[index] === '\\' && ['mysql', 'mariadb', 'clickhouse'].includes(engine)) { index += 2; continue; }
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") { index += 2; continue; }
          index++; closed = true; break;
        }
        index++;
      }
      if (!closed) return null;
      tokens.push({ kind: 'literal', start, end: index }); continue;
    }
    if (c === '`' || c === '"' || (c === '[' && engine === 'sqlserver')) {
      const close = c === '[' ? ']' : c;
      index++;
      let value = '';
      while (index < cursor) {
        if (sql[index] === close) {
          if (sql[index + 1] === close && index + 1 < cursor) { value += close; index += 2; continue; }
          index++; break;
        }
        value += sql[index++];
      }
      tokens.push({ kind: 'identifier', value, quote: close, start, end: index }); continue;
    }
    if (word(c)) {
      while (index < cursor && word(sql[index])) index++;
      tokens.push({ kind: 'identifier', value: sql.slice(start, index), start, end: index }); continue;
    }
    tokens.push({ kind: c, start, end: ++index });
  }
  return tokens;
}

export function getTableCompletions(sql, cursor, connection, force = false) {
  if (!connection?.schemas?.length || cursor < 0 || cursor > sql.length) return [];
  if (connection.engine === 'mongodb') {
    const match = /"(?:find|aggregate|insert|update|delete|count|distinct)"\s*:\s*"([^"\\]*)$/.exec(sql.slice(0, cursor));
    if (!match) return [];
    let database = connection.database;
    try { const explicit = JSON.parse(sql).$db; if (typeof explicit === 'string') database = explicit; } catch { /* Incomplete drafts use the selected database. */ }
    const prefix = match[1].toLocaleLowerCase(); const from = cursor - match[1].length - 1;
    const closing = sql.indexOf('"', cursor); const to = closing < 0 ? cursor : closing + 1;
    return (connection.schemas.find(schema => schema.name === database)?.objects || [])
      .filter(object => ['collection', 'view'].includes(object.type) && object.name.toLocaleLowerCase().startsWith(prefix)).slice(0, 15)
      .map(object => ({ name: object.name, schema: database, type: object.type, from, to, insert: JSON.stringify(object.name), rank: 0 }));
  }
  const tokens = tokensBefore(sql, cursor, connection.engine);
  if (!tokens) return [];
  const last = tokens.at(-1);
  const fragment = last?.kind === 'identifier' && last.end === cursor ? tokens.pop() : null;
  let qualifier;
  if (tokens.at(-1)?.kind === '.') {
    tokens.pop();
    const schema = tokens.pop();
    if (schema?.kind !== 'identifier') return [];
    qualifier = schema.value;
  }
  const context = tokens.at(-1);
  if (!force && !qualifier && !tableContexts.has(context?.value?.toUpperCase())) return [];
  const prefix = (fragment?.value ?? '').toLocaleLowerCase();
  const from = fragment?.start ?? cursor;
  let to = cursor;
  if (fragment?.quote && sql[cursor - 1] !== fragment.quote) {
    while (to < sql.length) {
      if (sql[to] === fragment.quote) {
        if (sql[to + 1] === fragment.quote) { to += 2; continue; }
        to++; break;
      }
      to++;
    }
  } else if (!fragment?.quote) while (word(sql[to])) to++;
  const quote = name => quoteIdentifier(name, connection.engine);
  const candidates = [];
  for (const schema of connection.schemas) {
    if (qualifier && schema.name.toLocaleLowerCase() !== qualifier.toLocaleLowerCase()) continue;
    for (const object of schema.objects) {
      if (!['table', 'view'].includes(object.type) || !object.name.toLocaleLowerCase().startsWith(prefix)) continue;
      const local = schema.name === connection.database;
      candidates.push({ name: object.name, schema: schema.name, type: object.type, from, to,
        insert: qualifier || local ? quote(object.name) : `${quote(schema.name)}.${quote(object.name)}`,
        rank: local ? 0 : 1 });
    }
  }
  return candidates.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || a.schema.localeCompare(b.schema)).slice(0, 15);
}

export function attachAutocomplete(editor, panel, getConnection, loadColumns) {
  let suggestions = [];
  let selected = 0;
  let session=null,timer=null,wantsOpen=false;const cache=new Map();const pending=new Set();
  const context = document.createElement('canvas').getContext('2d');
  function close() {
    wantsOpen=false;clearTimeout(timer);
    suggestions = []; panel.replaceChildren(); panel.classList.add('hidden');
    editor.setAttribute('aria-expanded', 'false'); editor.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    const item = suggestions[index];
    if (!item) return;
    editor.setRangeText(item.insert, item.from, item.to, 'end');
    close(); editor.focus();
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    close();
  }
  function position() {
    const style = getComputedStyle(editor);
    const lines = editor.value.slice(0, editor.selectionStart).split('\n');
    context.font = style.font;
    const line = lines.at(-1).replaceAll('\t', '  ');
    const left = parseFloat(style.paddingLeft) + context.measureText(line).width - editor.scrollLeft;
    const top = parseFloat(style.paddingTop) + lines.length * parseFloat(style.lineHeight) - editor.scrollTop;
    panel.style.left = `${Math.max(8, Math.min(left, editor.clientWidth - Math.min(420, editor.clientWidth - 16)))}px`;
    panel.style.top = `${Math.max(0, Math.min(top, editor.clientHeight - 24))}px`;
  }
  function render() {
    panel.replaceChildren();
    suggestions.forEach((item, index) => {
      const option = document.createElement('div');
      option.className = `completion-option${index === selected ? ' selected' : ''}`;
      option.id = `table-completion-${index}`; option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === selected));
      const name = document.createElement('span'); name.textContent = item.name;
      const detail = document.createElement('small'); detail.textContent = `${item.schema} · ${item.type === 'column'?'Campo':item.type === 'view' ? 'Vista' : item.type === 'collection' ? 'Colección' : 'Tabla'}`;
      option.append(name, detail);
      option.onmousedown = event => event.preventDefault();
      option.onclick = () => choose(index);
      panel.append(option);
    });
    panel.classList.remove('hidden'); editor.setAttribute('aria-expanded', 'true');
    editor.setAttribute('aria-activedescendant', `table-completion-${selected}`);
    position(); panel.children[selected]?.scrollIntoView({ block: 'nearest' });
  }
  function refresh(force = false) {
    if (document.activeElement !== editor || editor.selectionStart !== editor.selectionEnd) return close();
    wantsOpen=true;
    const connection=getConnection();const key=connection?.sessionKey||connection?.profileId||connection?.name;
    if(session!==key){session=key;cache.clear();pending.clear();}if(force)cache.clear();
    const columns=columnCompletions(editor.value,editor.selectionStart,connection,cache,tokensBefore,force);
    suggestions = columns.items.length?columns.items:getTableCompletions(editor.value, editor.selectionStart, connection, force);
    selected = 0;
    if (suggestions.length)render();else{panel.replaceChildren();panel.classList.add('hidden');editor.setAttribute('aria-expanded','false');editor.removeAttribute('aria-activedescendant');}
    clearTimeout(timer);
    const missing=columns.sources.filter((item,index,list)=>list.findIndex(other=>other.schema===item.schema&&other.name===item.name)===index).filter(item=>{const id=JSON.stringify([item.schema,item.name]);return !pending.has(id)&&(!cache.has(id)||Date.now()-cache.get(id).loaded>60000);});
    if(loadColumns&&missing.length)timer=setTimeout(async()=>{const ids=missing.map(item=>JSON.stringify([item.schema,item.name]));ids.forEach(id=>pending.add(id));try{const metadata=await loadColumns(missing.map(({schema,name})=>({schema,name})),key);if(session===key){for(const item of metadata)cache.set(JSON.stringify([item.schema,item.name]),{columns:item.columns,loaded:Date.now()});if(wantsOpen)refresh();}}catch{/* Typing never interrupts a running query or exposes stale metadata. */}finally{ids.forEach(id=>pending.delete(id));}},180);
  }
  editor.addEventListener('input', event => { if (!event.isComposing) refresh(); else close(); });
  editor.addEventListener('compositionend', () => refresh());
  editor.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.code === 'Space') { event.preventDefault(); event.stopPropagation(); refresh(true); return; }
    if (!suggestions.length || event.isComposing) return;
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      render();
    } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation(); choose(selected);
    } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) || event.ctrlKey || event.metaKey) close();
  });
  editor.addEventListener('blur', close);
  editor.addEventListener('click', close);
  editor.addEventListener('scroll', close);
  window.addEventListener('resize', close);
  document.querySelector('#refresh-explorer')?.addEventListener('click',()=>cache.clear());
  return { close, invalidate(){cache.clear();close();} };
}
