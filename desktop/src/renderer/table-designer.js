import { createTriggerEditor } from './trigger-editor.js';
import { renderSQLCode } from './sql-highlight.js';
const $ = selector => document.querySelector(selector);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) { if (tag === 'pre') renderSQLCode(node, text); else node.textContent = text; } if (className) node.classList.add(...className.split(' ')); return node; };
const copy = value => structuredClone(value);
function input(value, change, type = 'text') {
  const node = el('input'); node.type = type;
  if (type === 'checkbox') node.checked = !!value; else node.value = value ?? '';
  node.addEventListener(type === 'checkbox' ? 'change' : 'input', () => change(type === 'checkbox' ? node.checked : node.value));
  return node;
}
function select(value, values, change) {
  const node = el('select');
  for (const entry of values) { const [key, label] = Array.isArray(entry) ? entry : [entry, entry]; const option = el('option', label); option.value = key; node.append(option); }
  node.value = value;
  node.onchange = () => change(node.value);
  return node;
}
function field(title, control) { const label = el('label', undefined, 'designer-field'); label.append(el('span', title), control); return label; }
function button(title, action, style = 'secondary') { const node = el('button', title, style); node.type = 'button'; node.onclick = action; return node; }
const emptyColumn = name => ({ originalName: '', name, type: 'VARCHAR(255)', nullable: true, unsigned: false, zerofill: false, binary: false, autoIncrement: false, defaultKind: 'none', defaultValue: '', comment: '', charset: '', collation: '', generated: '', generatedStorage: 'VIRTUAL', onUpdate: '', invisible: false });

export function createTableDesigner({ api, show, runTask, onStatus, onQuery, notify }) {
  let original = null, draft = null, dirty = false, pane = 'columns', review = null, pending = false, session = null, metadataUnknown = false;
  const triggers = createTriggerEditor({ api, runTask, notify, onChange: snapshot => { if (snapshot) load(snapshot); pane = 'triggers'; renderPane(); } });
  function controls() {
    $('#designer-properties').inert = pending;
    $('#designer-content').inert = pending;
    $('#preview-table').disabled = pending || !draft || metadataUnknown;
    $('#apply-table').disabled = pending || !review;
    $('#reload-table').disabled = pending || !draft;
    $('#cancel-table-review').disabled = pending;
  }
  function title() {
    $('#designer-title').textContent = draft ? `${draft.schema}.${draft.name || 'Nueva tabla'}` : 'Tabla';
    $('#designer-tab-title').textContent = draft ? `${draft.name || 'Nueva tabla'} · Estructura${dirty ? ' *' : ''}` : 'Estructura';
    $('#designer-state').textContent = dirty ? 'Cambios pendientes de revisar y aplicar' : original ? 'Estructura cargada desde el servidor' : 'Nueva tabla · todavía no creada';
  }
  function changed() { dirty = true; review = null; $('#designer-error').textContent = ''; title(); controls(); }
  async function task(action) {
    if (pending) return;
    pending = true; controls();
    try { await runTask(async () => { try { await action(); } catch (error) { $('#designer-error').textContent = error.message; throw error; } }); }
    finally { pending = false; controls(); }
  }
  function uniqueName(prefix) {
    let index = 1, value = prefix.slice(0, 60);
    while (draft.indexes.some(item => item.name === value) || draft.foreignKeys.some(item => item.name === value)) value = `${prefix.slice(0, 55)}_${index++}`;
    return value;
  }
  function columnFlag(column, kind, value) {
    if (kind === 'PRIMARY') {
      let primary = draft.indexes.find(item => item.kind === 'PRIMARY');
      if (value) {
        column.nullable = false;
        if (!primary) { primary = { originalName: '', name: 'PRIMARY', kind: 'PRIMARY', method: 'BTREE', columns: [], comment: '', visible: true }; draft.indexes.push(primary); }
        if (!primary.columns.some(item => item.name === column.name)) primary.columns.push({ name: column.name, prefix: 0, order: 'ASC' });
      } else if (primary) { primary.columns = primary.columns.filter(item => item.name !== column.name); if (!primary.columns.length) draft.indexes = draft.indexes.filter(item => item !== primary); }
    } else if (value) {
      draft.indexes.push({ originalName: '', name: uniqueName(`uq_${column.name}`), kind: 'UNIQUE', method: 'BTREE', columns: [{ name: column.name, prefix: 0, order: 'ASC' }], comment: '', visible: true });
    } else draft.indexes = draft.indexes.filter(item => !(item.kind === 'UNIQUE' && item.columns.length === 1 && item.columns[0].name === column.name && !item.columns[0].prefix));
    changed(); renderPane();
  }
  function renderProperties() {
    const root = $('#designer-properties'); root.replaceChildren();
    const schema = input(draft.schema, () => {}); schema.readOnly = true;
    root.append(field('Base de datos', schema));
    for (const [key, label] of [['name', 'Nombre de tabla'], ['engine', 'Motor'], ['charset', 'Charset'], ['collation', 'Collation'], ['comment', 'Comentario de tabla']]) {
      const control = input(draft[key], value => { draft[key] = value; changed(); });
      control.dataset.property = key;
      const wrapper = field(label, control); if (key === 'comment') wrapper.classList.add('designer-comment');
      root.append(wrapper);
    }
  }
  function renderColumns(root) {
    const actions = el('div', undefined, 'structure-actions');
    actions.append(button('＋ Añadir columna', () => { draft.columns.push(emptyColumn(`columna_${draft.columns.length + 1}`)); changed(); renderPane(); }), el('p', 'PK: primaria · NN: no nulo · UQ: único · B: binario · UN: unsigned · ZF: zerofill · AI: autoincremento · G: generada'));
    root.append(actions);
    const table = el('table', undefined, 'structure-table'); const head = el('thead'); const titles = el('tr');
    for (const label of ['Nombre', 'Tipo', 'PK', 'NN', 'UQ', 'B', 'UN', 'ZF', 'AI', 'G', 'Predeterminado', 'Valor / expresión SQL', 'Expresión generada', 'Almacenamiento G', 'ON UPDATE', 'Charset', 'Collation', 'Comentario', 'Acciones']) titles.append(el('th', label));
    head.append(titles); table.append(head); const body = el('tbody'); table.append(body);
    draft.columns.forEach((column, index) => {
      const row = el('tr'); row.dataset.column = String(index);
      const cell = control => { const td = el('td'); td.append(control); row.append(td); return control; };
      const bind = (key, type = 'text', after) => {
        const control = input(column[key], value => { column[key] = value; after?.(value); changed(); }, type);
        control.dataset.field = key; control.setAttribute('aria-label', `${column.name}: ${key}`); return control;
      };
      const name = input(column.name, value => {
        const before = column.name; column.name = value;
        for (const item of draft.indexes) for (const part of item.columns) if (part.name === before) part.name = value;
        for (const key of draft.foreignKeys) key.columns = key.columns.map(part => part === before ? value : part);
        changed();
      }); name.dataset.field = 'name'; cell(name);
      cell(bind('type'));
      const primary = draft.indexes.some(item => item.kind === 'PRIMARY' && item.columns.some(part => part.name === column.name));
      const unique = draft.indexes.some(item => item.kind === 'UNIQUE' && item.columns.length === 1 && item.columns[0].name === column.name && !item.columns[0].prefix);
      cell(input(primary, value => columnFlag(column, 'PRIMARY', value), 'checkbox')).dataset.field = 'primary';
      cell(input(!column.nullable, value => { column.nullable = !value; changed(); }, 'checkbox')).dataset.field = 'notNull';
      cell(input(unique, value => columnFlag(column, 'UNIQUE', value), 'checkbox')).dataset.field = 'unique';
      for (const key of ['binary', 'unsigned', 'zerofill']) cell(bind(key, 'checkbox'));
      cell(input(column.autoIncrement, value => {
        column.autoIncrement = value;
        if (value) { column.nullable = false; if (!draft.indexes.some(item => item.columns[0]?.name === column.name)) columnFlag(column, draft.indexes.some(item => item.kind === 'PRIMARY') ? 'UNIQUE' : 'PRIMARY', true); }
        changed(); renderPane();
      }, 'checkbox')).dataset.field = 'autoIncrement';
      cell(input(!!column.generated, value => { column.generated = value ? '0' : ''; if (value) { column.defaultKind = 'none'; column.defaultValue = ''; column.autoIncrement = false; column.onUpdate = ''; } changed(); renderPane(); }, 'checkbox')).dataset.field = 'generatedFlag';
      cell(select(column.defaultKind, [['none', 'Sin DEFAULT'], ['value', 'Valor literal'], ['sql', 'SQL / expresión'], ['null', 'NULL']], value => { column.defaultKind = value; changed(); } )).dataset.field = 'defaultKind';
      cell(bind('defaultValue')); cell(bind('generated'));
      cell(select(column.generatedStorage, ['VIRTUAL', 'STORED'], value => { column.generatedStorage = value; changed(); }));
      for (const key of ['onUpdate', 'charset', 'collation', 'comment']) cell(bind(key));
      const controls = el('div', undefined, 'column-actions');
      const move = delta => { const target = index + delta; if (target < 0 || target >= draft.columns.length) return; [draft.columns[index], draft.columns[target]] = [draft.columns[target], draft.columns[index]]; changed(); renderPane(); };
      controls.append(button('↑', () => move(-1)), button('↓', () => move(1)), button('Eliminar', () => {
        if (draft.columns.length === 1) return notify('La tabla debe tener al menos una columna.');
        draft.columns.splice(index, 1);
        draft.indexes = draft.indexes.map(item => ({ ...item, columns: item.columns.filter(part => part.name !== column.name) })).filter(item => item.columns.length);
        draft.foreignKeys = draft.foreignKeys.filter(item => !item.columns.includes(column.name));
        changed(); renderPane();
      }, 'secondary column-delete'));
      cell(controls); body.append(row);
      if (column.unsupported) row.title = 'Esta columna contiene atributos avanzados; su modificación visual puede requerir SQL manual.';
    });
    root.append(table);
  }
  function renderIndexes(root) {
    root.append(button('＋ Crear índice', () => { draft.indexes.push({ originalName: '', name: uniqueName('idx_nuevo'), kind: 'INDEX', method: 'BTREE', columns: [{ name: draft.columns[0]?.name || '', prefix: 0, order: 'ASC' }], comment: '', visible: true }); changed(); renderPane(); }));
    if (!draft.indexes.length) root.append(el('p', 'La tabla no tiene índices.', 'designer-help'));
    draft.indexes.forEach((index, number) => {
      const box = el('fieldset', undefined, 'designer-object'); box.dataset.index = String(number);
      box.append(el('legend', index.name));
      if (index.unsupported) { box.append(el('p', 'Índice funcional o avanzado: se conserva sin cambios. Su edición requiere SQL manual.', 'designer-help')); box.disabled = true; }
      const head = el('div', undefined, 'designer-object-head'); head.append(el('strong', `${index.kind} · ${index.columns.map(item => item.name).join(', ')}`), button('Eliminar índice', () => { draft.indexes.splice(number, 1); changed(); renderPane(); })); box.append(head);
      const fields = el('div', undefined, 'designer-fields');
      const name = input(index.name, value => { index.name = value; changed(); }); name.dataset.indexField = 'name'; name.readOnly = index.kind === 'PRIMARY';
      fields.append(field('Nombre', name), field('Tipo', select(index.kind, ['PRIMARY', 'INDEX', 'UNIQUE', 'FULLTEXT', 'SPATIAL'], value => {
        const previous = index.kind; index.kind = value;
        if (value === 'PRIMARY') { index.name = 'PRIMARY'; for (const part of index.columns) { const col = draft.columns.find(item => item.name === part.name); if (col) col.nullable = false; } }
        else if (previous === 'PRIMARY') index.name = uniqueName('idx_nuevo');
        changed(); renderPane();
      })), field('Método', select(index.method, ['BTREE', 'HASH'], value => { index.method = value; changed(); })), field('Comentario', input(index.comment, value => { index.comment = value; changed(); })), field('Visible (MySQL 8+ para ocultar)', input(index.visible, value => { index.visible = value; changed(); }, 'checkbox')));
      box.append(fields, el('p', 'Columnas del índice, en orden. Prefijo 0: columna completa.', 'designer-help'));
      index.columns.forEach((part, partIndex) => {
        const row = el('div', undefined, 'index-column');
        row.append(select(part.name, draft.columns.map(item => item.name), value => { part.name = value; if (index.kind === 'PRIMARY') draft.columns.find(item => item.name === value).nullable = false; changed(); }), input(part.prefix, value => { part.prefix = Number(value); changed(); }, 'number'), select(part.order || 'ASC', ['ASC', 'DESC'], value => { part.order = value; changed(); }), button('Quitar', () => { index.columns.splice(partIndex, 1); changed(); renderPane(); }));
        box.append(row);
      });
      box.append(button('＋ Añadir columna al índice', () => { index.columns.push({ name: draft.columns[0]?.name || '', prefix: 0, order: 'ASC' }); changed(); renderPane(); }));
      root.append(box);
    });
  }
  function renderForeignKeys(root) {
    root.append(button('＋ Crear clave foránea', () => { draft.foreignKeys.push({ originalName: '', name: uniqueName('fk_nueva'), columns: [draft.columns[0]?.name || ''], referencedSchema: draft.schema, referencedTable: '', referencedColumns: [], onDelete: 'RESTRICT', onUpdate: 'RESTRICT' }); changed(); renderPane(); }));
    if (!draft.foreignKeys.length) root.append(el('p', 'La tabla no tiene claves foráneas.', 'designer-help'));
    draft.foreignKeys.forEach((key, index) => {
      const box = el('fieldset', undefined, 'designer-object'); box.dataset.foreignKey = String(index); box.append(el('legend', key.name));
      const head = el('div', undefined, 'designer-object-head'); head.append(el('strong', key.name), button('Eliminar relación', () => { draft.foreignKeys.splice(index, 1); changed(); renderPane(); })); box.append(head);
      const fields = el('div', undefined, 'designer-fields');
      for (const [property, label] of [['name', 'Nombre'], ['referencedSchema', 'Base referenciada'], ['referencedTable', 'Tabla referenciada']]) fields.append(field(label, input(key[property], value => { key[property] = value; changed(); })));
      fields.append(field('Columnas locales (en orden, separadas por coma)', input(key.columns.join(', '), value => { key.columns = value.split(',').map(item => item.trim()).filter(Boolean); changed(); })), field('Columnas referenciadas (mismo orden)', input(key.referencedColumns.join(', '), value => { key.referencedColumns = value.split(',').map(item => item.trim()).filter(Boolean); changed(); })));
      for (const property of ['onDelete', 'onUpdate']) fields.append(field(property === 'onDelete' ? 'ON DELETE' : 'ON UPDATE', select(key[property], ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'], value => { key[property] = value; changed(); })));
      box.append(fields); root.append(box);
    });
  }
  function renderPane() {
    const root = $('#designer-content'); root.replaceChildren();
    for (const node of document.querySelectorAll('[data-designer-pane]')) { const selected = node.dataset.designerPane === pane; node.classList.toggle('active', selected); node.setAttribute('aria-selected', String(selected)); }
    if (!draft) return;
    if (pane === 'columns') renderColumns(root);
    else if (pane === 'indexes') renderIndexes(root);
    else if (pane === 'foreignKeys') renderForeignKeys(root);
    else if (pane === 'ddl') {
      root.append(button('Abrir DDL en consulta SQL', () => onQuery(original?.ddl || '-- Revisa los cambios para generar el CREATE TABLE.')));
      root.append(el('pre', original?.ddl || 'Tabla nueva: todavía no existe en el servidor.', 'designer-code'));
    } else {
      const openTrigger = name => {
        if (!original || dirty || metadataUnknown) return notify('Aplica o recarga primero los cambios de estructura de la tabla.');
        triggers.open(original.schema, original.name, name);
      };
      root.append(button('＋ Crear trigger', () => openTrigger(null)));
      root.append(el('p', 'Edita el nombre, evento, momento y cuerpo SQL. Revisa el DROP + CREATE antes de aplicarlo.', 'designer-help'));
      if (original?.triggerWarning) root.append(el('p', original.triggerWarning, 'designer-help'));
      for (const trigger of original?.triggers || []) {
        const box = el('article', undefined, 'designer-object');
        const head = el('div', undefined, 'designer-object-head'); head.append(el('strong', `${trigger.TRIGGER_NAME} · ${trigger.ACTION_TIMING} ${trigger.EVENT_MANIPULATION}`), button('Editar trigger', () => openTrigger(trigger.TRIGGER_NAME)));
        box.append(head, el('pre', trigger.ACTION_STATEMENT, 'designer-code')); root.append(box);
      }
    }
    controls();
  }
  function load(snapshot) {
    original = snapshot; draft = copy(snapshot); dirty = false; review = null; metadataUnknown = false;
    $('#designer-error').textContent = ''; title(); renderProperties(); renderPane(); controls();
  }
  async function open(schema, table = null) {
    if (pending) return;
    if (dirty && !confirm('Hay cambios de estructura sin aplicar. ¿Descartarlos para abrir otra tabla?')) return;
    await task(async () => {
      const status = await api.status();
      if (!status.connected || !['mysql', 'mariadb'].includes(status.engine)) throw new Error('Conecta con MySQL o MariaDB para editar la estructura.');
      session = `${status.profileId}|${status.name}`;
      if (table) load(await api.inspectTable(schema, table));
      else {
        original = null; dirty = true; review = null; metadataUnknown = false;
        const id = { ...emptyColumn('id'), type: 'INT', nullable: false, autoIncrement: true };
        draft = { schema, name: 'nueva_tabla', engine: 'InnoDB', charset: '', collation: '', comment: '', columns: [id], indexes: [{ originalName: '', name: 'PRIMARY', kind: 'PRIMARY', method: 'BTREE', columns: [{ name: 'id', prefix: 0, order: 'ASC' }], comment: '', visible: true }], foreignKeys: [] };
        title(); renderProperties(); renderPane();
      }
      $('#designer-tab').classList.remove('hidden'); show('table-designer');
    });
  }
  $('#preview-table').onclick = () => task(async () => {
    if (!draft || metadataUnknown) throw new Error('Recarga la estructura antes de revisarla.');
    const status = await api.status();
    if (`${status.profileId}|${status.name}` !== session) throw new Error('La conexión ha cambiado. Vuelve a abrir la tabla.');
    review = await api.previewTable({ table: original?.name || null, version: original?.version || null, draft: copy(draft) });
    $('#table-review-target').textContent = `${draft.schema}.${draft.name}`;
    renderSQLCode($('#table-review-sql'), review.sql);
    $('#table-review-warnings').replaceChildren(...review.warnings.map(message => el('li', message)));
    $('#table-apply-error').textContent = '';
    $('#table-review-dialog').showModal();
  });
  $('#apply-table').onclick = () => task(async () => {
    if (!review) return;
    const token = review.token; review = null;
    try {
      const result = await api.applyTable(token);
      $('#table-review-dialog').close(); onStatus(result.status);
      if (result.table) load(result.table);
      else { dirty = false; metadataUnknown = true; title(); }
      notify(result.warning || 'Estructura aplicada y recargada.');
    } catch (error) { $('#table-apply-error').textContent = error.message; throw error; }
  });
  $('#cancel-table-review').onclick = () => { if (!pending) $('#table-review-dialog').close(); };
  $('#table-review-dialog').addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  $('#reload-table').onclick = () => {
    if (dirty && !confirm('¿Descartar los cambios del formulario y recargar la tabla?')) return;
    if (!original && !metadataUnknown) return;
    task(async () => load(await api.inspectTable(draft.schema, metadataUnknown ? draft.name : original.name)));
  };
  $('#close-designer').onclick = () => {
    if (pending || (dirty && !confirm('¿Cerrar el editor y descartar los cambios de estructura sin aplicar?'))) return;
    draft = null; original = null; dirty = false; review = null;
    $('#designer-tab').classList.add('hidden'); show('home');
  };
  for (const node of document.querySelectorAll('[data-designer-pane]')) node.onclick = () => { pane = node.dataset.designerPane; renderPane(); };
  function setConnection(status) {
    if (draft && (!status.connected || `${status.profileId}|${status.name}` !== session)) {
      review = null; metadataUnknown = true; $('#designer-error').textContent = 'La conexión ha cambiado. Abre de nuevo la tabla para aplicar cambios.'; controls();
    }
  }
  controls();
  return { open, setConnection };
}
