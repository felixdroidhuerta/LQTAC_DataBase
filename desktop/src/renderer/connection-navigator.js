import { DatabaseExplorer } from './explorer.js';
const $ = selector => document.querySelector(selector);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const dragType = 'application/x-lqtac-connections';

export function createConnectionNavigator({ api, runTask, notify, onConnect, onDisconnect, onActivate, onDelete, onEdit, onObject, isBusy }) {
  const root = $('#explorer');
  let overview = { profiles: [], groups: [], sessions: [], activeKey: null };
  let selected = new Set(), anchor = null, filter = '', generation = 0, groupingIds = [], assignmentIds = [];
  const expanded = new Map(), groupOpen = new Map(), trees = new Map();
  let visibleIds = [];
  const menu = $('#connection-context-menu');
  function profile(id) { return overview.profiles.find(item => item.id === id); }
  function status(id) { return overview.sessions.find(item => item.sessionKey === id); }
  function savedSelection() { return [...selected].filter(id => !!profile(id)); }
  async function action(callback) { await runTask(async () => { await callback(); await refresh(); }); }
  function clearMenu() { menu.classList.add('hidden'); menu.replaceChildren(); }
  function paintSelection() {
    for (const row of root.querySelectorAll('.connection-row')) { const active = selected.has(row.dataset.id); row.classList.toggle('selected', active); row.setAttribute('aria-selected', String(active)); }
  }
  function select(id, event = {}) {
    visibleIds = [...root.querySelectorAll('.connection-row')].filter(row => row.getClientRects().length > 0).map(row => row.dataset.id);
    if (event.shiftKey && anchor && visibleIds.includes(anchor)) {
      if (!event.ctrlKey && !event.metaKey) selected.clear();
      const start = visibleIds.indexOf(anchor), end = visibleIds.indexOf(id);
      for (const item of visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1)) selected.add(item);
    } else if (event.ctrlKey || event.metaKey) { if (selected.has(id)) selected.delete(id); else selected.add(id); anchor = id; }
    else { selected = new Set([id]); anchor = id; }
    paintSelection();
  }
  function context(event, items) {
    event.preventDefault(); clearMenu();
    for (const item of items) {
      const button = el('button', item.label); button.type = 'button'; button.setAttribute('role', 'menuitem');
      button.disabled = !!item.disabled;
      button.onclick = () => { clearMenu(); item.action(); };
      menu.append(button);
    }
    menu.classList.remove('hidden');
    menu.style.left = `${Math.max(5, Math.min(event.clientX, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(5, Math.min(event.clientY, innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  function groupDialog(ids = savedSelection()) {
    if (!ids.length) return notify('Selecciona una o varias conexiones guardadas para agruparlas.');
    groupingIds = [...ids]; $('#connection-group-name').value = '';
    $('#connection-group-summary').textContent = `${ids.length} conexión(es) seleccionada(s).`;
    $('#connection-group-error').textContent = ''; $('#connection-group-dialog').showModal(); $('#connection-group-name').focus();
  }
  function assignmentDialog(ids = savedSelection()) {
    if (!ids.length) return;
    assignmentIds = [...ids]; const select = $('#assign-group-target'); select.replaceChildren();
    for (const group of [{ id: '', name: 'Sin grupo' }, ...overview.groups, { id: '__new', name: 'Crear un grupo nuevo…' }]) { const option = el('option', group.name); option.value = group.id; select.append(option); }
    $('#assign-group-error').textContent = ''; $('#assign-group-dialog').showModal();
  }
  function connectionMenu(event, id, local) {
    if (!selected.has(id)) select(id);
    const ids = savedSelection(); const item = profile(id); const state = status(id);
    const actions = [{ label: 'Conectar', action: () => state?.connected ? onActivate(id) : onConnect(item) }];
    if (state?.connected) actions.push({ label: 'Desconectar', action: () => onDisconnect(id) });
    if (!local) {
      actions.push({ label: 'Editar conexión', action: () => onEdit(item) });
      actions.push({ label: ids.length > 1 ? 'Borrar conexiones seleccionadas' : 'Borrar', action: () => onDelete(ids) });
      actions.push({ label: 'Añadir a grupo…', action: () => assignmentDialog(ids) });
      actions.push({ label: ids.length > 1 ? 'Agrupar seleccionadas · Ctrl+Mayús+G' : 'Agrupar · Ctrl+Mayús+G', action: () => groupDialog(ids) });
      if (ids.some(value => overview.groups.some(group => group.connectionIds.includes(value)))) actions.push({ label: 'Sacar del grupo', action: () => action(() => api.moveConnections(ids, null)) });
    }
    context(event, actions);
  }
  function accepts(event) { return [...(event.dataTransfer?.types || [])].includes(dragType); }
  function dropZone(node, groupId) {
    node.addEventListener('dragover', event => { if (!accepts(event)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; node.classList.add('drag-over'); });
    node.addEventListener('dragleave', event => { if (!node.contains(event.relatedTarget)) node.classList.remove('drag-over'); });
    node.addEventListener('drop', event => {
      if (!accepts(event)) return;
      event.preventDefault(); event.stopPropagation(); node.classList.remove('drag-over');
      try {
        const ids = JSON.parse(event.dataTransfer.getData(dragType));
        if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every(id => typeof id === 'string' && !!profile(id))) throw new Error('Selección de conexiones no válida.');
        action(() => api.moveConnections(ids, groupId));
      } catch (error) { notify(error.message); }
    });
  }
  function matches(item, term) {
    const data = status(item.id);
    return !term || item.name.toLocaleLowerCase().includes(term) || data?.schemas.some(schema => schema.name.toLocaleLowerCase().includes(term) || schema.objects.some(object => object.name.toLocaleLowerCase().includes(term)));
  }
  function connectionRow(item, parent, term) {
    const id = item.id; const data = status(id); const connected = !!data?.connected;
    visibleIds.push(id);
    const container = el('section', undefined, 'connection-entry'); container.dataset.connectionId = id;
    const row = el('div', undefined, `connection-row${overview.activeKey === id ? ' active-connection' : ''}`);
    row.dataset.id = id; row.tabIndex = 0; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-selected', String(selected.has(id))); row.setAttribute('aria-expanded', String(!!expanded.get(id)));
    row.draggable = !item.local; row.title = `${item.name}${item.host ? ' · ' + item.host + ':' + item.port : ''}`;
    const toggle = el('button', expanded.get(id) ? '▾' : '▸', 'connection-expand'); toggle.title = 'Desplegar conexión';
    toggle.setAttribute('aria-expanded', String(!!expanded.get(id)));
    toggle.onclick = event => { event.stopPropagation(); expanded.set(id, !expanded.get(id)); render(); };
    const name = el('span', item.name, 'connection-name');
    const power = el('button', '⏻', `connection-power ${connected ? 'power-on' : 'power-off'}`);
    power.title = `${connected ? 'Desconectar' : 'Conectar'} ${item.name}`; power.setAttribute('aria-label', power.title); power.setAttribute('aria-pressed', String(connected));
    power.onclick = event => { event.stopPropagation(); if (connected) onDisconnect(id); else onConnect(item); };
    row.append(toggle, name, power);
    row.onclick = event => { if (isBusy()) return; select(id, event); if (!event.ctrlKey && !event.metaKey && !event.shiftKey && connected) { expanded.set(id, true); onActivate(id); } };
    row.ondblclick = event => { event.preventDefault(); if (!connected && !isBusy()) onConnect(item); };
    row.oncontextmenu = event => connectionMenu(event, id, item.local);
    row.onkeydown = event => {
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); select(id, event); if (event.key === 'Enter') connected ? onActivate(id) : onConnect(item); }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { const rect = row.getBoundingClientRect(); connectionMenu({ preventDefault: () => event.preventDefault(), clientX: rect.left + 15, clientY: rect.bottom }, id, item.local); }
    };
    row.ondragstart = event => {
      if (isBusy() || item.local) { event.preventDefault(); return; }
      if (!selected.has(id)) select(id);
      event.dataTransfer.setData(dragType, JSON.stringify(savedSelection())); event.dataTransfer.effectAllowed = 'move';
    };
    row.ondragend = () => { for (const target of root.querySelectorAll('.drag-over')) target.classList.remove('drag-over'); };
    container.append(row); parent.append(container);
    if (expanded.get(id)) {
      const body = el('div', undefined, 'connection-objects'); body.setAttribute('role', 'group'); container.append(body);
      if (!connected) body.append(el('p', 'Sin conexión. Pulsa ⏻ para conectar.', 'empty-group'));
      else {
        let tree = trees.get(id);
        if (!tree) {
          tree = new DatabaseExplorer(body, {
            onQuery: sql => onObject(id, 'query', sql), onSelect: schema => onObject(id, 'select', schema),
            onEdit: (schema, table) => onObject(id, 'edit', schema, table), onCreate: schema => onObject(id, 'create', schema),onEditObject:(schema,object)=>onObject(id,'definition',schema,object)
          }); trees.set(id, tree);
        }
        tree.root = body;
        tree.render(data, item.name.toLocaleLowerCase().includes(term) ? '' : term);
      }
    }
  }
  function render() {
    const scroll = root.scrollTop;
    root.className = 'connection-navigator'; root.setAttribute('role', 'tree'); root.setAttribute('aria-multiselectable', 'true'); root.setAttribute('aria-label', 'Conexiones y bases de datos');
    root.replaceChildren(); visibleIds = [];
    const term = filter.trim().toLocaleLowerCase();
    const assigned = new Set(overview.groups.flatMap(group => group.connectionIds));
    for (const group of overview.groups) {
      const members = overview.profiles.filter(item => group.connectionIds.includes(item.id));
      const groupMatches = group.name.toLocaleLowerCase().includes(term);
      const visible = members.filter(item => groupMatches || matches(item, term));
      if (term && !groupMatches && !visible.length) continue;
      const details = el('details', undefined, 'connection-group'); details.dataset.groupId = group.id;
      details.open = term ? true : groupOpen.get(group.id) !== false;
      const summary = el('summary', `▣ ${group.name} (${members.length})`); details.append(summary); root.append(details);
      details.ontoggle = () => { if (!term && root.contains(details)) groupOpen.set(group.id, details.open); };
      summary.oncontextmenu = event => context(event, [{ label: 'Desagrupar (conservar conexiones)', action: () => action(() => api.ungroupConnections(group.id)) }]);
      dropZone(details, group.id);
      const content = el('div', undefined, 'group-members'); content.setAttribute('role', 'group'); details.append(content);
      for (const item of visible) connectionRow(item, content, groupMatches ? '' : term);
      if (!members.length) content.append(el('p', 'Arrastra conexiones a este grupo.', 'empty-group'));
    }
    const ungrouped = el('section', undefined, 'ungrouped-connections'); ungrouped.dataset.groupId = ''; root.append(ungrouped); dropZone(ungrouped, null);
    if (overview.groups.length) ungrouped.append(el('div', 'Sin grupo · soltar aquí para sacar del grupo', 'ungrouped-label'));
    for (const item of overview.profiles.filter(item => !assigned.has(item.id) && matches(item, term))) connectionRow(item, ungrouped, term);
    const local = status('local');
    if (local?.connected && matches({ id: 'local', name: local.name }, term)) connectionRow({ id: 'local', name: local.name, local: true }, ungrouped, term);
    if (!overview.profiles.length && !local?.connected) ungrouped.append(el('p', 'No hay conexiones guardadas. Crea una desde ＋.', 'explorer-empty'));
    if (term && !visibleIds.length) ungrouped.append(el('p', 'No hay coincidencias.', 'empty-group'));
    root.scrollTop = scroll; paintSelection();
    const count = overview.sessions.filter(item => item.connected).length;
    $('#sessions-count').textContent = String(count); $('#sessions-dot').classList.toggle('connected', count > 0);
  }
  async function refresh() {
    if (!api) return;
    const request = ++generation;
    try {
      const next = await api.connectionOverview(); if (request !== generation) return;
      for (const state of next.sessions) if (state.connected && !status(state.sessionKey)?.connected) expanded.set(state.sessionKey, true);
      overview = next;
      selected = new Set([...selected].filter(id => profile(id) || id === 'local'));
      render();
    } catch (error) { notify(error.message); }
  }
  $('#connection-group-form').onsubmit = event => {
    event.preventDefault(); if (!event.target.reportValidity()) return;
    action(async () => {
      try { await api.createConnectionGroup($('#connection-group-name').value, groupingIds); $('#connection-group-dialog').close(); }
      catch (error) { $('#connection-group-error').textContent = error.message; throw error; }
    });
  };
  $('#assign-group-form').onsubmit = event => {
    event.preventDefault(); const group = $('#assign-group-target').value;
    if (group === '__new') { $('#assign-group-dialog').close(); groupDialog(assignmentIds); return; }
    action(async () => { try { await api.moveConnections(assignmentIds, group || null); $('#assign-group-dialog').close(); } catch (error) { $('#assign-group-error').textContent = error.message; throw error; } });
  };
  $('#cancel-connection-group').onclick = () => $('#connection-group-dialog').close();
  $('#cancel-assign-group').onclick = () => $('#assign-group-dialog').close();
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) clearMenu(); });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') clearMenu();
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'g') { event.preventDefault(); if (!isBusy()) groupDialog(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && root.contains(document.activeElement)) { event.preventDefault(); selected = new Set([...root.querySelectorAll('.connection-row')].filter(row => row.getClientRects().length > 0 && !!profile(row.dataset.id)).map(row => row.dataset.id)); paintSelection(); }
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); clearMenu(); root.querySelector('.connection-row.selected')?.focus(); }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const buttons = [...menu.querySelectorAll('button:not(:disabled)')]; const index = buttons.indexOf(document.activeElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
  });
  return { refresh, setFilter: value => { filter = value; render(); } };
}
