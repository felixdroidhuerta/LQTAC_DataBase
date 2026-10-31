const defaults = Object.freeze({ sidebarWidth: 251, editorFraction: 0.45 });
const storageKey = 'lqtac.panelLayout';
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function initPanelLayout() {
  const root = document.documentElement;
  const sidebar = document.querySelector('#sidebar');
  const sql = document.querySelector('#sql');
  const editor = document.querySelector('.query-editor');
  const handles = {
    sidebarWidth: document.querySelector('#sidebar-splitter'),
    editorFraction: document.querySelector('#editor-splitter')
  };
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch { /* Use defaults when storage is unavailable. */ }
  const state = { ...defaults, sidebarCollapsed: saved?.sidebarCollapsed === true };
  const toggle = document.createElement("button");toggle.id="toggle-explorer";toggle.type="button";toggle.className="explorer-toggle";toggle.setAttribute("aria-controls","sidebar");
  const identity=document.querySelector(".topbar>div:first-child");identity.classList.add("workspace-identity");identity.prepend(toggle);
  toggle.onclick=()=>{finish(true);state.sidebarCollapsed=!state.sidebarCollapsed;apply();save();toggle.focus();};
  for (const key of Object.keys(defaults)) if (typeof saved?.[key] === 'number' && Number.isFinite(saved[key])) state[key] = saved[key];
  state.editorFraction = clamp(state.editorFraction, 0.05, 0.95);
  let drag = null;

  function limits(key) {
    if (key === 'sidebarWidth') {
      const rail = document.querySelector('.rail').getBoundingClientRect().width;
      return { min: 210, max: Math.max(210, Math.min(600, innerWidth - rail - 7 - 600)) };
    }
    const fixed = ['.editor-caption', '.results-header', '#editor-splitter','#result-tabs'].reduce((height, selector) => height + (document.querySelector(selector)?.getBoundingClientRect().height||0), 0);
    const available = Math.max(0, document.querySelector('#query-workspace').clientHeight - fixed);
    const minimum = Math.min(80, available / 2);
    return { min: minimum, max: Math.max(minimum, available - 80), available };
  }
  function actual(key) {
    if (key === 'sidebarWidth') return sidebar.getBoundingClientRect().width;
    return editor.getBoundingClientRect().height;
  }
  function apply() {
    root.classList.toggle("explorer-collapsed",state.sidebarCollapsed);sidebar.inert=state.sidebarCollapsed;toggle.textContent=state.sidebarCollapsed?"☷ ›":"‹ ☷";toggle.title=state.sidebarCollapsed?"Mostrar explorador":"Ocultar explorador";toggle.setAttribute("aria-label",toggle.title);toggle.setAttribute("aria-expanded",String(!state.sidebarCollapsed));
    for (const [key, handle] of Object.entries(handles)) {
      if (key === 'editorFraction' && !sql.clientHeight) continue;
      const range = limits(key);
      const desired = key === 'editorFraction' ? state[key] * range.available : state[key];
      const value = Math.round(clamp(desired, range.min, range.max));
      root.style.setProperty({ sidebarWidth: '--sidebar-width', editorFraction: '--editor-height' }[key], `${value}px`);
      handle.setAttribute('aria-valuemin', String(Math.round(range.min)));
      handle.setAttribute('aria-valuemax', String(Math.round(range.max)));
      handle.setAttribute('aria-valuenow', String(value));
      handle.setAttribute('aria-valuetext', `${value} píxeles`);
    }
  }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Layout still works for this session. */ }
  }
  function setSize(key, size) {
    const range = limits(key);
    const value = clamp(size, range.min, range.max);
    state[key] = key === 'editorFraction' ? value / Math.max(1, range.available) : value;
    apply();
  }
  function finish(cancel = false) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (cancel) Object.assign(state, previous.state);
    previous.handle.classList.remove('dragging');
    document.body.classList.remove('resizing-panels', 'resizing-columns', 'resizing-rows');
    if (previous.handle.hasPointerCapture(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
    apply(); save();
  }
  for (const [key, handle] of Object.entries(handles)) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || drag) return;
      event.preventDefault(); handle.focus();
      drag = { key, handle, pointerId: event.pointerId, coordinate: key === 'sidebarWidth' ? event.clientX : event.clientY, size: actual(key), state: { ...state } };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
      document.body.classList.add('resizing-panels', key === 'sidebarWidth' ? 'resizing-columns' : 'resizing-rows');
      document.querySelector('#table-completions').classList.add('hidden');
    });
    handle.addEventListener('lostpointercapture', () => finish(true));
    handle.addEventListener('dblclick', () => { finish(true); state[key] = defaults[key]; apply(); save(); });
    handle.addEventListener('keydown', event => {
      if (event.key === 'Escape' && drag) { event.preventDefault(); finish(true); return; }
      const backward = key === 'sidebarWidth' ? 'ArrowLeft' : 'ArrowUp';
      const forward = key === 'sidebarWidth' ? 'ArrowRight' : 'ArrowDown';
      if (![backward, forward, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const range = limits(key);
      const value = event.key === 'Home' ? range.min : event.key === 'End' ? range.max : actual(key) + (event.key === forward ? 1 : -1) * (event.shiftKey ? 40 : 10);
      setSize(key, value); save();
    });
  }
  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const coordinate = drag.key === 'sidebarWidth' ? event.clientX : event.clientY;
    setSize(drag.key, drag.size + coordinate - drag.coordinate);
  });
  window.addEventListener('pointerup', event => { if (drag?.pointerId === event.pointerId) finish(); });
  window.addEventListener('pointercancel', () => finish(true));
  window.addEventListener('blur', () => finish(true));
  window.addEventListener('resize', apply);
  const observer = new ResizeObserver(apply);
  observer.observe(sidebar); observer.observe(sql); observer.observe(document.querySelector('#query-workspace'));
  observer.observe(document.querySelector('#result-tabs'));observer.observe(document.querySelector('.results-header'));
  apply();
  return { apply };
}
