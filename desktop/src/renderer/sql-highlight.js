const keywords = new Set(('SELECT FROM WHERE AS AND OR NOT IN IS NULL TRUE FALSE JOIN LEFT RIGHT INNER OUTER FULL CROSS ON USING GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET UNION ALL DISTINCT WITH RECURSIVE INSERT INTO VALUES UPDATE SET DELETE CREATE ALTER DROP TRUNCATE TABLE VIEW INDEX UNIQUE PRIMARY KEY FOREIGN REFERENCES CONSTRAINT DEFAULT AUTO_INCREMENT UNSIGNED ZEROFILL IF EXISTS ADD COLUMN CHANGE MODIFY RENAME TO FIRST AFTER ENGINE CHARACTER COLLATE COMMENT GENERATED ALWAYS VIRTUAL STORED INVISIBLE VISIBLE SHOW DATABASE DATABASES SCHEMA SCHEMAS TABLES DESCRIBE EXPLAIN USE BEGIN END THEN ELSE ELSEIF CASE WHEN RETURN RETURNS DECLARE WHILE LOOP REPEAT UNTIL DO LEAVE ITERATE FOR EACH ROW TRIGGER BEFORE INSTEAD OF PROCEDURE FUNCTION REPLACE IGNORE DUPLICATE BETWEEN LIKE REGEXP RLIKE ESCAPE INTERVAL OVER PARTITION ROWS RANGE UNBOUNDED PRECEDING FOLLOWING CURRENT EXCLUDE WINDOW NATURAL CASCADE RESTRICT ACTION NO CHECK COMMIT ROLLBACK START TRANSACTION SAVEPOINT RELEASE GRANT REVOKE DEFINER SQL SECURITY DELIMITER SIGNAL RESIGNAL CONDITION HANDLER CONTINUE EXIT CALL OUT INOUT DETERMINISTIC READS MODIFIES DATA MATCH AGAINST BOOLEAN MODE LOCK UNLOCK TABLESPACE ANALYZE OPTIMIZE VACUUM PRAGMA ATTACH DETACH EXCEPT INTERSECT').split(' '));
const types = new Set(('TINYINT SMALLINT MEDIUMINT INT INTEGER BIGINT DECIMAL NUMERIC FLOAT DOUBLE REAL BIT BOOL DATE DATETIME TIMESTAMP TIME YEAR CHAR VARCHAR BINARY VARBINARY TEXT TINYTEXT MEDIUMTEXT LONGTEXT BLOB TINYBLOB MEDIUMBLOB LONGBLOB JSON ENUM GEOMETRY POINT LINESTRING POLYGON MULTIPOINT MULTILINESTRING MULTIPOLYGON GEOMETRYCOLLECTION SERIAL').split(' '));
const constants = new Set(['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'LOCALTIME', 'LOCALTIMESTAMP', 'CURRENT_USER', 'SESSION_USER']);
for (const keyword of ['TOP', 'FETCH', 'NEXT', 'ONLY', 'OUTPUT', 'RETURNING', 'IDENTITY', 'DUAL', 'EXEC', 'EXECUTE', 'TRY', 'CATCH', 'RAISERROR', 'THROW', 'ELSIF', 'EXCEPTION', 'SEARCH_PATH', 'CURRENT_SCHEMA', 'MATERIALIZED']) keywords.add(keyword);
for (const type of ['NVARCHAR', 'NCHAR', 'VARCHAR2', 'NVARCHAR2', 'NUMBER', 'CLOB', 'NCLOB', 'RAW', 'UUID', 'JSONB', 'BYTEA', 'TIMESTAMPTZ', 'DATETIME2', 'DATETIMEOFFSET', 'UNIQUEIDENTIFIER', 'MONEY']) types.add(type);
const identifierStart = character => !!character && /[\p{L}_$]/u.test(character);
const identifierPart = character => !!character && /[\p{L}\p{N}_$]/u.test(character);

export function tokenizeSQL(source, { dialect = 'mysql' } = {}) {
  if (dialect === 'mongodb') {
    // JSON tokens only; never evaluate shell code or alter the stored command.
    const matcher = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\],:]|\s+|./gs;
    return [...source.matchAll(matcher)].map(match => {
      const text = match[0];
      const type = text[0] === '"' ? /^\s*:/.test(source.slice(match.index + text.length)) ? 'identifier' : 'string' : /^-?\d/.test(text) ? 'number' : /^(true|false|null)$/.test(text) ? 'keyword' : /^\s+$/.test(text) ? 'plain' : 'punctuation';
      return { text, type };
    });
  }
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const start = index; const c = source[index]; let type = 'plain';
    if (/\s/.test(c)) { while (index < source.length && /\s/.test(source[index])) index++; }
    else if ((source.startsWith('--', index) && (!['mysql', 'mariadb'].includes(dialect) || !source[index + 2] || /\s/.test(source[index + 2]))) || (c === '#' && ['mysql', 'mariadb', 'clickhouse'].includes(dialect))) {
      const end = source.indexOf('\n', index); index = end < 0 ? source.length : end; type = 'comment';
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 2; type = 'comment';
    } else if (dialect === 'postgresql' && c === '$' && /^\$(?:[a-zA-Z_][\w]*)?\$/.test(source.slice(index))) {
      const delimiter = /^\$(?:[a-zA-Z_][\w]*)?\$/.exec(source.slice(index))[0]; const end = source.indexOf(delimiter, index + delimiter.length);
      index = end < 0 ? source.length : end + delimiter.length; type = 'string';
    } else if (dialect === 'sqlserver' && c === '[') {
      index++; while (index < source.length) { if (source[index++] === ']') { if (source[index] === ']') index++; else break; } } type = 'identifier';
    } else if (["'", '"', '`'].includes(c)) {
      index++;
      while (index < source.length) {
        if (source[index] === '\\' && c !== '`' && ['mysql', 'mariadb', 'clickhouse'].includes(dialect)) { index = Math.min(source.length, index + 2); continue; }
        if (source[index] === c) { if (source[index + 1] === c) { index += 2; continue; } index++; break; }
        index++;
      }
      type = c === '`' || (c === '"' && ['sqlite', 'postgresql', 'sqlserver', 'oracle'].includes(dialect)) ? 'identifier' : 'string';
    } else if (/\d/.test(c) || (c === '.' && /\d/.test(source[index + 1] || ''))) {
      const number = /^(?:0x[\da-f]+|0b[01]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i.exec(source.slice(index));
      index += number?.[0].length || 1; type = 'number';
    } else if (c === '@' && dialect !== 'sqlite') {
      index++; if (source[index] === '@') index++;
      while (identifierPart(source[index]) || source[index] === '.') index++;
      type = 'variable';
    } else if (identifierStart(c)) {
      while (identifierPart(source[index])) index++;
      const upper = source.slice(start, index).toUpperCase();
      if (upper === 'NEW' || upper === 'OLD') type = 'variable';
      else if (types.has(upper)) type = 'type';
      else if (constants.has(upper)) type = 'function';
      else if (keywords.has(upper)) type = 'keyword';
      else { let next = index; while (/\s/.test(source[next] || '') && next < source.length) next++; type = source[next] === '(' ? 'function' : 'identifier'; }
    } else { index++; type = /[=<>+*/%!|&^~:\-]/.test(c) ? 'operator' : 'punctuation'; }
    tokens.push({ type, text: source.slice(start, index) });
  }
  return tokens;
}

export function renderSQLCode(element, source, options) {
  const fragment = document.createDocumentFragment();
  // Large scripts remain readable without producing hundreds of thousands of nodes.
  const tokens = source.length > 250000 ? [{ type: 'plain', text: source }] : tokenizeSQL(source, options);
  for (const token of tokens) {
    if (token.type === 'plain') fragment.append(document.createTextNode(token.text));
    else { const span = document.createElement('span'); span.className = `sql-token-${token.type}`; span.textContent = token.text; fragment.append(span); }
  }
  element.classList.add('sql-highlight-code'); element.replaceChildren(fragment);
}

export function attachSQLHighlight(editor, options = {}) {
  let surface = editor.parentElement;
  if (!surface.classList.contains('query-editor')) {
    surface = document.createElement('div'); editor.before(surface); surface.append(editor);
  }
  surface.classList.add('sql-source-surface');
  const layer = document.createElement('pre'); layer.className = 'sql-highlight-layer'; layer.setAttribute('aria-hidden', 'true');
  surface.insertBefore(layer, editor);
  let dialect = options.dialect || 'mysql';
  function sync() {
    const style = getComputedStyle(editor);
    for (const property of ['font', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'tabSize', 'textIndent', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) layer.style[property] = style[property];
    layer.style.left = `${editor.offsetLeft + parseFloat(style.borderLeftWidth || 0)}px`;
    layer.style.top = `${editor.offsetTop + parseFloat(style.borderTopWidth || 0)}px`;
    layer.style.width = `${editor.clientWidth}px`; layer.style.height = `${editor.clientHeight}px`;
    layer.scrollTop = editor.scrollTop; layer.scrollLeft = editor.scrollLeft;
  }
  function refresh() {
    renderSQLCode(layer, editor.value, { dialect });
    // Keep the final empty line aligned with the native textarea's scroll extent.
    layer.append(document.createTextNode('\u200b'));
    editor.classList.add('sql-source-input'); sync();
  }
  editor.addEventListener('input', refresh);
  editor.addEventListener('scroll', sync);
  editor.addEventListener('compositionstart', () => surface.classList.add('sql-composing'));
  editor.addEventListener('compositionend', () => { surface.classList.remove('sql-composing'); refresh(); });
  window.addEventListener('resize', sync);
  const observer = new ResizeObserver(sync); observer.observe(editor);
  refresh();
  return { refresh, setDialect: value => { const next = ['sqlite', 'mongodb', 'postgresql', 'sqlserver', 'oracle', 'clickhouse', 'mariadb'].includes(value) ? value : 'mysql'; if (next !== dialect) { dialect = next; refresh(); } } };
}
