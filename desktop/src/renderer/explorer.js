import { quoteIdentifier, sqlLiteral } from './dialect.js';
const groups = [
  { type: 'table', title: 'Tablas', icon: '▤' },
  { type: 'collection', title: 'Colecciones', icon: '▧' },
  { type: 'view', title: 'Vistas', icon: '◈' },
  { type: 'procedure', title: 'Procedimientos', icon: 'ƒ' },
  { type: 'function', title: 'Funciones', icon: 'ƒ' }
];
const node = (tag, text, className) => {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = text;
  if (className) value.className = className;
  return value;
};
export function objectQuery(schema, object, remote) {
  if (remote === 'mongodb') return JSON.stringify({ find: object.name, filter: {}, limit: 100, $db: schema }, null, 2);
  const engine = typeof remote === 'string' ? remote : remote ? 'mysql' : 'sqlite';
  const quote = name => quoteIdentifier(name, engine);
  const identifier = `${quote(schema)}.${quote(object.name)}`;
  if (['procedure', 'function'].includes(object.type)) {
    if (engine === 'postgresql') return /^\d+$/.test(object.oid || '') ? `SELECT pg_get_functiondef(${object.oid}::oid);` : `SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${sqlLiteral(schema)} AND p.proname=${sqlLiteral(object.name)};`;
    if (engine === 'sqlserver') return `SELECT OBJECT_DEFINITION(OBJECT_ID(N${sqlLiteral(identifier)})) AS definition;`;
    if (engine === 'oracle') return `SELECT TEXT FROM ALL_SOURCE WHERE OWNER=${sqlLiteral(schema)} AND NAME=${sqlLiteral(object.name)} AND TYPE=${sqlLiteral(object.type.toUpperCase())} ORDER BY LINE;`;
  }
  if (engine === 'sqlserver') return `SELECT TOP (100) * FROM ${identifier};`;
  if (engine === 'oracle') return `SELECT * FROM ${identifier} FETCH FIRST 100 ROWS ONLY;`;
  if (object.type === 'procedure') return `SHOW CREATE PROCEDURE ${identifier};`;
  if (object.type === 'function') return `SHOW CREATE FUNCTION ${identifier};`;
  return `SELECT * FROM ${identifier} LIMIT 100;`;
}

export class DatabaseExplorer {
  constructor(root, { onQuery, onSelect, onEdit, onCreate, onEditObject }) {
    this.root = root; this.onQuery = onQuery; this.onSelect = onSelect;
    this.onEdit = onEdit; this.onCreate = onCreate;
    this.onEditObject=onEditObject;
    this.open = new Map(); this.session = null;
  }
  render(data, filter = '') {
    const session = data.profileId || data.name;
    if (this.session !== session) { this.open.clear(); this.session = session; }
    this.root.replaceChildren();
    if (!data.name) { this.root.append(node('p', 'Conecta con un servidor o abre una base SQLite.', 'explorer-empty')); return; }
    const remote = data.engine !== 'sqlite';
    const editable = ['mysql', 'mariadb'].includes(data.engine);
    const term = filter.trim().toLocaleLowerCase();
    const branch = (key, title, initial, className) => {
      const details = node('details', undefined, className);
      details.open = term ? true : this.open.has(key) ? this.open.get(key) : initial;
      const summary = node('summary', title);
      details.append(summary);
      details.ontoggle = () => { if (!term && this.root.contains(details)) this.open.set(key, details.open); };
      return { details, summary };
    };
    const server = branch('server', data.name, true, 'server-tree');
    this.root.append(server.details);
    let matches = 0;
    for (const schema of data.schemas ?? []) {
      const schemaMatches = schema.name.toLocaleLowerCase().includes(term);
      const objects = term && !schemaMatches ? schema.objects.filter(object => object.name.toLocaleLowerCase().includes(term)) : schema.objects;
      if (term && !schemaMatches && !objects.length) continue;
      matches++;
      const active = schema.name === data.database;
      const database = branch(JSON.stringify(['schema', schema.name]), undefined, active, `schema-tree${active ? ' active-database' : ''}`);
      database.summary.append(node('span', schema.name, 'schema-name'));
      database.summary.title = schema.name;
      if (remote && data.engine !== 'sqlserver') {
        const select = node('button', active ? '★' : '☆', 'select-database');
        select.title = data.scope === 'schema' ? active ? 'Esquema predeterminado' : 'Usar como esquema predeterminado' : active ? 'Base de datos predeterminada' : 'Usar como base de datos predeterminada';
        select.setAttribute('aria-label', `${select.title}: ${schema.name}`);
        select.onclick = event => { event.preventDefault(); event.stopPropagation(); if (!active) this.onSelect(schema.name); };
        database.summary.append(select);
      }
      server.details.append(database.details);
      for (const group of groups) {
        if (data.engine === 'mongodb' ? !['collection', 'view'].includes(group.type) : group.type === 'collection') continue;
        if (!remote && ['procedure', 'function'].includes(group.type)) continue;
        const items = objects.filter(object => object.type === group.type);
        if (term && !schemaMatches && !items.length) continue;
        const folder = branch(JSON.stringify(['group', schema.name, group.type]), `${group.title} (${items.length})`, group.type === 'table', 'object-group');
        database.details.append(folder.details);
        if (editable && group.type === 'table' && this.onCreate) {
          const create = node('button', '＋', 'create-table');
          create.title = `Crear tabla en ${schema.name}`;
          create.setAttribute('aria-label', create.title);
          create.onclick = event => { event.preventDefault(); event.stopPropagation(); this.onCreate(schema.name); };
          folder.summary.append(create);
        }
        if (!items.length) folder.details.append(node('p', 'Sin objetos visibles', 'empty-group'));
        for (const object of items) {
          const button = node('button', `${group.icon} ${object.name}`, 'tree-object');
          button.title = `${schema.name}.${object.name}`;
          button.dataset.schema = schema.name;
          button.dataset.object = object.name;
          button.dataset.type = object.type;
          button.onclick = () => this.onQuery(objectQuery(schema.name, object, data.engine));
          if (editable && object.type === 'table' && this.onEdit) {
            const row = node('div', undefined, 'tree-object-row');
            const edit = node('button', '✎', 'edit-table');
            edit.title = `Editar estructura de ${schema.name}.${object.name}`;
            edit.setAttribute('aria-label', edit.title);
            edit.dataset.schema = schema.name; edit.dataset.table = object.name;
            edit.onclick = () => this.onEdit(schema.name, object.name);
            row.append(button, edit); folder.details.append(row);
          } else if(['view','procedure','function'].includes(object.type)&&this.onEditObject){
            const row=node('div',undefined,'tree-object-row');const edit=node('button','✎','edit-object');edit.title=`Editar definición de ${schema.name}.${object.name}`;edit.setAttribute('aria-label',edit.title);edit.dataset.schema=schema.name;edit.dataset.object=object.name;edit.dataset.type=object.type;edit.onclick=()=>this.onEditObject(schema.name,object);row.append(button,edit);folder.details.append(row);
          } else folder.details.append(button);
        }
      }
    }
    if (!matches) server.details.append(node('p', term ? 'No hay coincidencias.' : 'No hay bases de datos visibles para este usuario.', 'empty-group'));
  }
}
