export function initSQLToolbar({ api, notify }) {
  const stop = document.createElement('button'); stop.id = 'stop-query'; stop.type = 'button'; stop.className = 'mini-tool query-stop'; stop.textContent = '■'; stop.disabled = true;
  stop.dataset.localAction = 'stop-query'; stop.setAttribute('aria-label', 'Detener consulta'); stop.dataset.hint = 'Detener consulta · Cancela la sentencia activa y detiene el resto del script';
  document.querySelector('#run-all').after(stop);
  let active = null;
  const released = new Set();
  api.onExecutionReleased(({runId}) => { released.add(runId); if(released.size>100)released.delete(released.values().next().value);if(active?.runId===runId){active=null;stop.disabled=true;stop.removeAttribute('aria-busy');} });
  stop.onclick = async () => {
    if (!active || active.stopping) return;
    const target = active; target.stopping = true; stop.disabled = true; stop.setAttribute('aria-busy', 'true');
    try {
      const accepted = await api.cancelQuery(target.runId, target.key);
      if (active !== target) return;
      if (accepted) { if(!target.pending)document.querySelector('#query-info').textContent = 'Cancelando consulta…';else{target.stopping=false;stop.disabled=false;}notify('Cancelación solicitada.'); }
      else notify('La consulta ya ha terminado.');
    } catch (error) { if (active === target) { target.stopping = false; stop.disabled = false; stop.removeAttribute('aria-busy'); notify(error.message); } }
  };
  function groupTools(toolbar, groups) {
    toolbar.classList.add('functional-tools');
    for (const [name, selectors] of groups) {
      const items = selectors.map(selector => document.querySelector(selector)).filter(item => item && toolbar.contains(item));
      if (!items.length) continue;
      const group = document.createElement('span'); group.className = 'tool-group'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', name);
      if (toolbar.querySelector('.tool-group')) { const divider = document.createElement('span'); divider.className = 'tool-separator'; divider.textContent = '|'; divider.setAttribute('aria-hidden', 'true'); toolbar.append(divider); }
      group.append(...items); toolbar.append(group);
    }
  }
  groupTools(document.querySelector('.editor-caption .mini-tools'), [
    ['Archivos SQL', ['#open-sql-file', '#save-sql-file', '#save-sql-as']],
    ['Formato', ['#format-query']],
    ['Ejecución', ['#run-selection', '#run-all', '#stop-query']],
    ['Estructura y relaciones', ['#show-relations']]
  ]);
  groupTools(document.querySelector('.results-header .mini-tools'), [
    ['Copiar', ['#copy-result-cell']], ['Exportar', ['#export-csv', '#export-xlsx', '#export-result-index']],
    ['Filas visibles', ['.results-header label.mini-tool']],
    ['Editar datos', ['#edit-result-data','#apply-result-data','#discard-result-data','#null-result-cell']]
  ]);
  return {
    prepare(value) { active = { ...value, stopping: false }; stop.disabled = true; stop.removeAttribute('aria-busy'); stop.dataset.hint = value.engine === 'sqlite' ? 'SQLite en memoria no admite cancelación durante una consulta' : 'Detener consulta · Cancela la sentencia activa y detiene el resto del script'; },
    running(runId) { if (active?.runId === runId && !active.stopping && active.engine !== 'sqlite') stop.disabled = false; },
    cancelling(runId, canRetry) { if (active?.runId === runId) { active.stopping = !canRetry; stop.disabled = !canRetry; stop.setAttribute('aria-busy', String(!canRetry)); stop.dataset.hint = canRetry ? 'Reintentar cancelación · La conexión sigue abierta; la consulta aún está ocupada' : 'Esperando confirmación de cancelación del servidor'; } },
    observe(status) { if(status.queryPending&&status.pendingRunId&&!released.has(status.pendingRunId)&&(!active||active.pending)){active={runId:status.pendingRunId,key:status.sessionKey,engine:status.engine,pending:true,stopping:false};stop.disabled=false;stop.dataset.hint='Reintentar Detener · La consulta anterior termina en segundo plano';}else if(active?.pending&&status.sessionKey!==active.key){active=null;stop.disabled=true;stop.removeAttribute('aria-busy');} },
    finish(runId, pending = false) { if (active?.runId === runId) { if(pending&&!released.has(runId)){active.pending=true;active.stopping=false;stop.disabled=false;stop.dataset.hint='Reintentar Detener · La consulta anterior termina en segundo plano';}else{active = null;stop.disabled = true;}stop.removeAttribute('aria-busy'); } }
  };
}
