const { createHash } = require('node:crypto');

function identifier(value) {
  if (typeof value !== 'string' || !value || value.length > 64 || /[\0\r\n]/.test(value)) throw new Error('Nombre SQL no válido (máximo 64 caracteres).');
  return '`' + value.replaceAll('`', '``') + '`';
}
function literal(value, mode = '') {
  let text = String(value);
  if (!mode.includes('NO_BACKSLASH_ESCAPES')) text = text.replaceAll('\\', '\\\\');
  return "'" + text.replaceAll("'", "''") + "'";
}
// Split only at top level: ENUM values, expressions and quoted comments may contain commas.
function splitDefinitions(text, mode = '') {
  const parts = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && !mode.includes('NO_BACKSLASH_ESCAPES')) { i++; continue; }
      if (c === quote) { if (text[i + 1] === quote) i++; else quote = ''; }
    } else if (['\'', '"', '`'].includes(c)) quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts;
}
function sqlFragment(value, mode = '') {
  const text = String(value ?? '').trim();
  if (!text || text.length > 10000) throw new Error('La expresión SQL está vacía o es demasiado larga.');
  let depth = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && !mode.includes('NO_BACKSLASH_ESCAPES')) { i++; continue; }
      if (c === quote) { if (text[i + 1] === quote) i++; else quote = ''; }
    } else if (['\'', '"', '`'].includes(c)) quote = c;
    else if (c === '(') depth++;
    else if (c === ')') { if (--depth < 0) throw new Error('Paréntesis no equilibrados.'); }
    else if (c === ';' || c === '#' || text.startsWith('--', i) || text.startsWith('/*', i)) throw new Error('La expresión no admite separadores ni comentarios SQL.');
  }
  if (quote || depth) throw new Error('Comillas o paréntesis no equilibrados.');
  return text;
}
function matchingClose(raw, offset, mode = '') {
  let depth = 0, quote = '';
  for (let i = offset; i < raw.length; i++) {
    const c = raw[i];
    if (quote) { if (c === '\\' && !mode.includes('NO_BACKSLASH_ESCAPES')) i++; else if (c === quote) { if (raw[i + 1] === quote) i++; else quote = ''; } }
    else if (["'", '"', '`'].includes(c)) quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  throw new Error('No se pudo interpretar una expresión de la definición SQL.');
}
function defaultFromDefinition(raw, mode = '') {
  // Find DEFAULT outside strings and expressions, including comments containing that word.
  let depth = 0, quote = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === '\\' && !mode.includes('NO_BACKSLASH_ESCAPES')) i++;
      else if (c === quote) { if (raw[i + 1] === quote) i++; else quote = ''; }
      continue;
    }
    if (["'", '"', '`'].includes(c)) { quote = c; continue; }
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth--; continue; }
    const match = depth === 0 && (i === 0 || /\s/.test(raw[i - 1])) ? /^DEFAULT\s+/i.exec(raw.slice(i)) : null;
    if (!match) continue;
    const start = i + match[0].length;
    if (raw[start] === '(') return { defaultKind: 'sql', defaultValue: raw.slice(start, matchingClose(raw, start, mode) + 1) };
    if (raw[start] === "'" || raw[start] === '"') {
      const delimiter = raw[start];
      for (let end = start + 1; end < raw.length; end++) {
        if (raw[end] === '\\' && !mode.includes('NO_BACKSLASH_ESCAPES')) end++;
        else if (raw[end] === delimiter) { if (raw[end + 1] === delimiter) end++; else return { defaultKind: 'sql', defaultValue: raw.slice(start, end + 1) }; }
      }
      throw new Error('No se pudo leer el valor predeterminado de una columna.');
    }
    return { defaultKind: 'sql', defaultValue: /^\S+/.exec(raw.slice(start))?.[0] || '' };
  }
  return { defaultKind: 'none', defaultValue: '' };
}
async function rows(adapter, sql, values = [], mode = '') {
  let index = 0;
  const query = values.length ? sql.replace(/\?/g, () => literal(values[index++], mode)) : sql;
  const [data, fields] = await adapter.connection.promise().query({ sql: query, timeout: 30000 });
  return data.map(row => Object.fromEntries(fields.map((field, index) => [field.name, row[index]])));
}
function structureFingerprint(ddl, mode) {
  let text = '', quote = '';
  for (let i = 0; i < ddl.length; i++) {
    const c = ddl[i];
    if (quote) {
      text += c;
      if (c === '\\' && !mode.includes('NO_BACKSLASH_ESCAPES')) { text += ddl[++i] || ''; continue; }
      if (c === quote) { if (ddl[i + 1] === quote) text += ddl[++i]; else quote = ''; }
    } else if (["'", '"', '`'].includes(c)) { quote = c; text += c; }
    else {
      const counter = /^(AUTO_INCREMENT\s*=\s*)\d+/i.exec(ddl.slice(i));
      if (counter && (i === 0 || /\s/.test(ddl[i - 1]))) { text += 'AUTO_INCREMENT=<counter>'; i += counter[0].length - 1; }
      else text += c;
    }
  }
  return createHash('sha256').update(text + '\n' + mode).digest('hex');
}
async function inspectTable(adapter, schema, table) {
  const target = `${identifier(schema)}.${identifier(table)}`;
  const [create] = await rows(adapter, `SHOW CREATE TABLE ${target}`);
  if (!create?.['Create Table']) throw new Error('El objeto no es una tabla editable.');
  const ddl = create['Create Table'];
  const [settings] = await rows(adapter, 'SELECT @@SESSION.sql_mode AS sql_mode, VERSION() AS version');
  const bodyStart = ddl.indexOf('(');
  const definitions = splitDefinitions(ddl.slice(bodyStart + 1, matchingClose(ddl, bodyStart, settings.sql_mode)), settings.sql_mode);
  const rawColumns = new Map();
  for (const definition of definitions) {
    const match = /^`((?:``|[^`])+)`\s+([\s\S]+)$/.exec(definition);
    const ansi = !match && /^"((?:""|[^"])+)"\s+([\s\S]+)$/.exec(definition);
    const plain = !match && !ansi && /^([A-Za-z0-9_$]+)\s+([\s\S]+)$/.exec(definition);
    if (match) rawColumns.set(match[1].replaceAll('``', '`'), match[2]);
    else if (ansi) rawColumns.set(ansi[1].replaceAll('""', '"'), ansi[2]);
    else if (plain) rawColumns.set(plain[1], plain[2]);
  }
  const [info] = await rows(adapter, 'SELECT ENGINE, TABLE_COLLATION, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [schema, table], settings.sql_mode);
  const columns = (await rows(adapter, `SHOW FULL COLUMNS FROM ${target}`)).map(column => {
    const raw = rawColumns.get(column.Field);
    if (!raw) throw new Error(`No se pudo interpretar la columna ${column.Field}.`);
    const generated = /\b(VIRTUAL|STORED|PERSISTENT)\s+GENERATED\b/i.test(column.Extra || '') ? /\bGENERATED ALWAYS AS\s*\(([\s\S]*)\)\s+(VIRTUAL|STORED|PERSISTENT)/i.exec(raw) : null;
    const type = column.Type.replace(/(?:\s+(?:unsigned|zerofill))+$/i, '').trim();
    const flags = column.Type.slice(type.length);
    return {
      originalName: column.Field, name: column.Field, type,
      nullable: column.Null === 'YES', unsigned: /\bunsigned\b/i.test(flags), zerofill: /\bzerofill\b/i.test(flags), binary: /^\w+(?:\([^)]*\))?\s+BINARY\b/i.test(raw),
      autoIncrement: /auto_increment/i.test(column.Extra || ''),
      ...defaultFromDefinition(raw, settings.sql_mode), comment: column.Comment || '',
      charset: column.Collation?.split('_')[0] || '', collation: column.Collation || '',
      generated: generated?.[1] || '', generatedStorage: generated?.[2] === 'VIRTUAL' ? 'VIRTUAL' : 'STORED',
      onUpdate: /\bon update\s+(CURRENT_TIMESTAMP(?:\(\d*\))?)/i.exec(column.Extra || '')?.[1] || '',
      raw, unsupported: /COLUMN_FORMAT|\bSTORAGE\b|\bSRID\b|ENGINE_ATTRIBUTE|\bCHECK\b|\bREFERENCES\b|\bCOMPRESSED\b|\bENCRYPTED\b|WITH SYSTEM VERSIONING|WITHOUT SYSTEM VERSIONING/i.test(raw),
      invisible: /\bINVISIBLE\b/i.test(column.Extra || '')
    };
  });
  const indexes = [];
  for (const index of await rows(adapter, `SHOW INDEX FROM ${target}`)) {
    let group = indexes.find(item => item.name === index.Key_name);
    if (!group) {
      group = { originalName: index.Key_name, name: index.Key_name, kind: index.Key_name === 'PRIMARY' ? 'PRIMARY' : index.Index_type === 'FULLTEXT' ? 'FULLTEXT' : index.Index_type === 'SPATIAL' ? 'SPATIAL' : Number(index.Non_unique) ? 'INDEX' : 'UNIQUE', method: ['BTREE', 'HASH'].includes(index.Index_type) ? index.Index_type : 'BTREE', columns: [], comment: index.Index_comment || '', visible: index.Visible !== 'NO', unsupported: false };
      indexes.push(group);
    }
    if (!index.Column_name || index.Expression) group.unsupported = true;
    group.columns.push({ name: index.Column_name || index.Expression || '', prefix: Number(index.Sub_part) || 0, order: index.Collation === 'D' ? 'DESC' : 'ASC' });
  }
  const foreignKeys = [];
  const constraints = await rows(adapter, 'SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION', [schema, table], settings.sql_mode);
  for (const item of constraints) {
    let key = foreignKeys.find(value => value.name === item.CONSTRAINT_NAME);
    if (!key) {
      key = { originalName: item.CONSTRAINT_NAME, name: item.CONSTRAINT_NAME, columns: [], referencedSchema: item.REFERENCED_TABLE_SCHEMA, referencedTable: item.REFERENCED_TABLE_NAME, referencedColumns: [], onUpdate: item.UPDATE_RULE, onDelete: item.DELETE_RULE };
      foreignKeys.push(key);
    }
    key.columns.push(item.COLUMN_NAME); key.referencedColumns.push(item.REFERENCED_COLUMN_NAME);
  }
  let triggers = [], triggerWarning;
  try { triggers = await rows(adapter, 'SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?', [schema, table], settings.sql_mode); }
  catch { triggerWarning = 'Los permisos actuales no permiten consultar los triggers.'; }
  const properties = { schema, name: table, engine: info?.ENGINE || '', charset: info?.TABLE_COLLATION?.split('_')[0] || '', collation: info?.TABLE_COLLATION || '', comment: info?.TABLE_COMMENT || '' };
  return { ...properties, columns, indexes, foreignKeys, triggers, triggerWarning, ddl, sqlMode: settings.sql_mode || '', serverVersion: settings.version, version: structureFingerprint(ddl, settings.sql_mode || '') };
}
function typeSQL(value) {
  const type = String(value).trim();
  const match = /^([A-Z]+)(?:\s*\(([\s\S]*)\))?$/i.exec(type);
  const simple = new Set('TINYINT SMALLINT MEDIUMINT INT INTEGER BIGINT DECIMAL NUMERIC FLOAT DOUBLE REAL BIT BOOLEAN BOOL DATE DATETIME TIMESTAMP TIME YEAR CHAR VARCHAR BINARY VARBINARY TINYTEXT TEXT MEDIUMTEXT LONGTEXT TINYBLOB BLOB MEDIUMBLOB LONGBLOB JSON GEOMETRY POINT LINESTRING POLYGON MULTIPOINT MULTILINESTRING MULTIPOLYGON GEOMETRYCOLLECTION ENUM SET'.split(' '));
  if (!match || !simple.has(match[1].toUpperCase())) throw new Error(`Tipo de dato no admitido: ${type}.`);
  if (['ENUM', 'SET'].includes(match[1].toUpperCase())) {
    if (!match[2] || !/^\s*'(?:''|\\.|[^'\\])*'(?:\s*,\s*'(?:''|\\.|[^'\\])*')*\s*$/.test(match[2])) throw new Error('ENUM y SET requieren una lista de valores entre comillas simples.');
  } else if (match[2] !== undefined && !/^\d+(?:\s*,\s*\d+)?$/.test(match[2])) throw new Error('Longitud o precisión de tipo no válida.');
  return type;
}
function simpleOption(value, label) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`${label} no válido.`);
  return value;
}
function columnSQL(column, mode) {
  const type = typeSQL(column.type);
  const numeric = /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL)\b/i.test(type);
  if ((column.unsigned || column.zerofill) && !numeric) throw new Error(`UN y ZF requieren un tipo numérico: ${column.name}.`);
  if (column.binary && !/^(CHAR|VARCHAR|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT)\b/i.test(type)) throw new Error(`B requiere un tipo de texto: ${column.name}.`);
  if (column.autoIncrement && (!/^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)\b/i.test(type) || column.nullable || column.generated)) throw new Error(`AUTO_INCREMENT requiere una columna entera NOT NULL: ${column.name}.`);
  let sql = `${identifier(column.name)} ${type}${column.unsigned ? ' UNSIGNED' : ''}${column.zerofill ? ' ZEROFILL' : ''}${column.binary ? ' BINARY' : ''}`;
  if (column.charset) sql += ` CHARACTER SET ${simpleOption(column.charset, 'Charset')}`;
  if (column.collation && !column.binary) sql += ` COLLATE ${simpleOption(column.collation, 'Collation')}`;
  if (column.generated) {
    if (!['VIRTUAL', 'STORED'].includes(column.generatedStorage)) throw new Error('Almacenamiento de columna generada no válido.');
    sql += ` GENERATED ALWAYS AS (${sqlFragment(column.generated, mode)}) ${column.generatedStorage}`;
    if (column.defaultKind !== 'none' || column.autoIncrement || column.onUpdate) throw new Error('Una columna generada no admite valor predeterminado, AUTO_INCREMENT ni ON UPDATE.');
  }
  sql += column.nullable ? ' NULL' : ' NOT NULL';
  if (column.defaultKind === 'value') sql += ` DEFAULT ${literal(column.defaultValue, mode)}`;
  else if (column.defaultKind === 'sql') sql += ` DEFAULT ${sqlFragment(column.defaultValue, mode)}`;
  else if (column.defaultKind === 'null') { if (!column.nullable) throw new Error(`DEFAULT NULL requiere permitir NULL: ${column.name}.`); sql += ' DEFAULT NULL'; }
  else if (column.defaultKind !== 'none') throw new Error('Tipo de valor predeterminado no válido.');
  if (column.onUpdate) {
    if (!/^CURRENT_TIMESTAMP(?:\(\d*\))?$/i.test(column.onUpdate)) throw new Error('ON UPDATE solo admite CURRENT_TIMESTAMP con precisión opcional.');
    sql += ` ON UPDATE ${column.onUpdate}`;
  }
  if (column.autoIncrement) sql += ' AUTO_INCREMENT';
  if (column.comment) sql += ` COMMENT ${literal(column.comment, mode)}`;
  if (column.invisible) sql += ' INVISIBLE';
  return sql;
}
const columnFields = ['name', 'type', 'nullable', 'unsigned', 'zerofill', 'binary', 'autoIncrement', 'defaultKind', 'defaultValue', 'comment', 'charset', 'collation', 'generated', 'generatedStorage', 'onUpdate', 'invisible'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function indexSQL(index, names, mode) {
  if (!['PRIMARY', 'INDEX', 'UNIQUE', 'FULLTEXT', 'SPATIAL'].includes(index.kind)) throw new Error('Tipo de índice no válido.');
  if (!index.columns?.length) throw new Error('Selecciona al menos una columna para cada índice.');
  const columns = index.columns.map(column => {
    if (!names.has(column.name)) throw new Error(`Columna de índice inexistente: ${column.name}.`);
    const prefix = Number(column.prefix || 0);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 65535) throw new Error('Longitud de prefijo no válida.');
    if (!['ASC', 'DESC'].includes(column.order || 'ASC')) throw new Error('Orden de índice no válido.');
    return identifier(column.name) + (prefix ? `(${prefix})` : '') + (column.order === 'DESC' ? ' DESC' : '');
  });
  let sql = index.kind === 'PRIMARY' ? 'PRIMARY KEY' : `${index.kind === 'INDEX' ? '' : index.kind + ' '}INDEX ${identifier(index.name)}`;
  if (['PRIMARY', 'INDEX', 'UNIQUE'].includes(index.kind)) {
    if (!['BTREE', 'HASH'].includes(index.method)) throw new Error('Método de índice no válido.');
    sql += ` USING ${index.method}`;
  }
  sql += ` (${columns.join(', ')})`;
  if (index.comment) sql += ` COMMENT ${literal(index.comment, mode)}`;
  if (index.visible === false) sql += ' INVISIBLE';
  return sql;
}
function foreignKeySQL(key, names) {
  if (!key.columns?.length || key.columns.length !== key.referencedColumns?.length) throw new Error('La relación requiere el mismo número de columnas locales y referenciadas.');
  for (const column of key.columns) if (!names.has(column)) throw new Error(`Columna de relación inexistente: ${column}.`);
  const actions = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'];
  if (!actions.includes(key.onDelete) || !actions.includes(key.onUpdate)) throw new Error('Acción de clave foránea no válida.');
  return `CONSTRAINT ${identifier(key.name)} FOREIGN KEY (${key.columns.map(identifier).join(', ')}) REFERENCES ${identifier(key.referencedSchema)}.${identifier(key.referencedTable)} (${key.referencedColumns.map(identifier).join(', ')}) ON DELETE ${key.onDelete} ON UPDATE ${key.onUpdate}`;
}
function buildTablePlan(original, draft) {
  if (!draft || !Array.isArray(draft.columns) || !draft.columns.length || draft.columns.length > 1024 || !Array.isArray(draft.indexes) || !Array.isArray(draft.foreignKeys)) throw new Error('Definición de tabla incompleta.');
  const target = `${identifier(draft.schema)}.${identifier(original?.name || draft.name)}`;
  identifier(draft.name);
  if (original && draft.schema !== original.schema) throw new Error('No se puede cambiar la base de datos desde este editor.');
  const names = new Set();
  for (const column of draft.columns) {
    identifier(column.name);
    if (names.has(column.name.toLowerCase())) throw new Error(`Columna duplicada: ${column.name}.`);
    names.add(column.name.toLowerCase());
  }
  const exactNames = new Set(draft.columns.map(column => column.name));
  if (draft.columns.filter(column => column.autoIncrement).length > 1) throw new Error('Solo puede haber una columna AUTO_INCREMENT.');
  if (draft.indexes.filter(index => index.kind === 'PRIMARY').length > 1) throw new Error('Solo puede haber una clave primaria.');
  for (const column of draft.columns) {
    if (column.autoIncrement && !draft.indexes.some(index => index.columns?.[0]?.name === column.name)) throw new Error(`AUTO_INCREMENT requiere un índice que comience por ${column.name}.`);
    if (column.nullable && draft.indexes.some(index => index.kind === 'PRIMARY' && index.columns.some(item => item.name === column.name))) throw new Error(`La clave primaria no puede admitir NULL: ${column.name}.`);
  }
  for (const list of [draft.indexes, draft.foreignKeys]) {
    const used = new Set();
    for (const item of list) { identifier(item.name); if (used.has(item.name.toLowerCase())) throw new Error(`Nombre duplicado: ${item.name}.`); used.add(item.name.toLowerCase()); }
  }
  const mode = original ? original.sqlMode || '' : draft.sqlMode || '';
  const warnings = [];
  const options = [];
  for (const [key, keyword] of [['engine', 'ENGINE'], ['charset', 'DEFAULT CHARACTER SET'], ['collation', 'COLLATE']]) {
    if (draft[key] && (!original || draft[key] !== original[key])) options.push(`${keyword} = ${simpleOption(draft[key], keyword)}`);
  }
  if (!original || draft.comment !== original.comment) options.push(`COMMENT = ${literal(draft.comment || '', mode)}`);
  if (!original) {
    const definitions = [...draft.columns.map(column => columnSQL(column, mode)), ...draft.indexes.map(index => indexSQL(index, exactNames, mode)), ...draft.foreignKeys.map(key => foreignKeySQL(key, exactNames))];
    return { sql: `CREATE TABLE ${target} (\n  ${definitions.join(',\n  ')}\n)${options.length ? '\n' + options.join(' ') : ''};`, warnings, name: draft.name };
  }
  const originals = new Map(original.columns.map(column => [column.name, column]));
  const origins = new Set();
  const renames = new Map();
  for (const column of draft.columns) if (column.originalName) {
    if (!originals.has(column.originalName) || origins.has(column.originalName)) throw new Error('Referencia de columna original no válida.');
    origins.add(column.originalName); renames.set(column.originalName, column.name);
    if (column.name !== column.originalName && originals.has(column.name)) throw new Error('No se puede renombrar una columna al nombre de otra columna original en el mismo cambio.');
  }
  const operations = [];
  function diffObjects(key, comparable, drop, create) {
    const before = original[key]; const after = draft[key];
    const seen = new Set();
    for (const item of after) if (item.originalName) {
      if (seen.has(item.originalName) || !before.some(old => old.name === item.originalName)) throw new Error('Referencia de objeto original no válida.');
      seen.add(item.originalName);
    }
    const changed = old => { const next = after.find(item => item.originalName === old.name); return !next || !same(comparable(old, true), comparable(next, false)); };
    for (const old of before) if (changed(old)) { if (old.unsupported) throw new Error(`El índice funcional ${old.name} debe modificarse mediante SQL.`); operations.push(drop(old)); warnings.push(`Se sustituye o elimina ${key === 'indexes' ? 'el índice' : 'la relación'} ${old.name}.`); }
    return after.filter(item => !item.originalName || changed(before.find(old => old.name === item.originalName))).map(create);
  }
  const normalizeIndex = (item, old) => ({ name: item.name, kind: item.kind, method: item.method, columns: item.columns.map(column => ({ ...column, name: old ? renames.get(column.name) || column.name : column.name })), comment: item.comment, visible: item.visible });
  const normalizeKey = (item, old) => ({ name: item.name, columns: item.columns.map(name => old ? renames.get(name) || name : name), referencedSchema: item.referencedSchema, referencedTable: item.referencedTable, referencedColumns: item.referencedColumns, onDelete: item.onDelete, onUpdate: item.onUpdate });
  const addedKeys = diffObjects('foreignKeys', normalizeKey, key => `DROP FOREIGN KEY ${identifier(key.name)}`, key => `ADD ${foreignKeySQL(key, exactNames)}`);
  const addedIndexes = diffObjects('indexes', normalizeIndex, index => index.kind === 'PRIMARY' ? 'DROP PRIMARY KEY' : `DROP INDEX ${identifier(index.name)}`, index => `ADD ${indexSQL(index, exactNames, mode)}`);
  for (const column of original.columns) if (!origins.has(column.name)) { operations.push(`DROP COLUMN ${identifier(column.name)}`); warnings.push(`Se eliminará la columna ${column.name} y sus datos.`); }
  const reordered = !same(original.columns.filter(column => origins.has(column.name)).map(column => renames.get(column.name)), draft.columns.filter(column => column.originalName).map(column => column.name));
  draft.columns.forEach((column, index) => {
    const old = originals.get(column.originalName);
    const changed = !old || columnFields.some(key => column[key] !== old[key]);
    const position = index ? ` AFTER ${identifier(draft.columns[index - 1].name)}` : ' FIRST';
    if (!old) operations.push(`ADD COLUMN ${columnSQL(column, mode)}${position}`);
    else if (changed || reordered) {
      if (changed && old.unsupported) throw new Error(`La columna ${old.name} tiene atributos avanzados que deben editarse mediante SQL.`);
      const definition = changed ? columnSQL(column, mode) : `${identifier(column.name)} ${old.raw}`;
      operations.push(`CHANGE COLUMN ${identifier(old.name)} ${definition}${position}`);
      if (changed) warnings.push(`Se modificará la columna ${old.name}; los valores existentes deben ser compatibles.`);
    }
  });
  operations.push(...addedIndexes, ...addedKeys, ...options);
  if (draft.name !== original.name) operations.push(`RENAME TO ${identifier(draft.schema)}.${identifier(draft.name)}`);
  if (!operations.length) throw new Error('No hay cambios para aplicar.');
  return { sql: `ALTER TABLE ${target}\n  ${operations.join(',\n  ')};`, warnings, name: draft.name };
}
module.exports = { inspectTable, buildTablePlan, identifier, literal, columnSQL, splitDefinitions, defaultFromDefinition };
