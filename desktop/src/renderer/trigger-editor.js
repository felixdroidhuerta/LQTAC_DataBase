import { attachSQLHighlight, renderSQLCode } from './sql-highlight.js';
const $ = selector => document.querySelector(selector);
export function createTriggerEditor({ api, runTask, onChange, notify }) {
  let original = null, target = null, review = null, pending = false;
  const dialog = $('#trigger-editor-dialog');
  const highlight = attachSQLHighlight($('#trigger-body'));
  function controls() {
    $('#trigger-fields').inert = pending;
    $('#cancel-trigger').disabled = pending; $('#review-trigger').disabled = pending;
    $('#apply-trigger').disabled = pending || !review;
    $('#apply-trigger').classList.toggle('hidden', !review);
  }
  async function task(action) {
    if (pending) return;
    pending = true; controls();
    try { await runTask(async () => { try { await action(); } catch (error) { $('#trigger-editor-message').textContent = error.message; throw error; } }); }
    finally { pending = false; controls(); }
  }
  async function open(schema, table, name = null) {
    await task(async () => {
      original = name ? await api.inspectTrigger(schema, name) : null;
      const status = await api.status();
      target = { schema, table, profile: status.profileId };
      if (original && original.table !== table) throw new Error('El trigger ya no pertenece a esta tabla. Recarga la estructura.');
      $('#trigger-editor-heading').textContent = name ? `Editar trigger ${name}` : 'Crear trigger';
      $('#trigger-target').textContent = `${schema}.${table}`;
      $('#trigger-name').value = original?.name || 'nuevo_trigger';
      $('#trigger-timing').value = original?.timing || 'BEFORE';
      $('#trigger-event').value = original?.event || 'INSERT';
      $('#trigger-body').value = original?.body || 'BEGIN\n  -- Escribe aquí las instrucciones del trigger.\nEND';
      $('#trigger-definer').textContent = original ? `Definer conservado: ${original.definer}. Se mantiene el orden relativo cuando no cambia el evento.` : 'El nuevo trigger pertenecerá a la cuenta actual.';
      review = null; $('#trigger-review-sql').classList.add('hidden'); $('#trigger-editor-message').textContent = '';
      dialog.showModal();
      highlight.refresh();
    });
  }
  async function checkSession() { const status = await api.status(); if (!status.connected || status.profileId !== target.profile) throw new Error('La conexión ha cambiado. Cierra y vuelve a abrir el trigger.'); }
  $('#review-trigger').onclick = () => task(async () => {
    await checkSession();
    review = await api.previewTrigger({ originalName: original?.name || null, version: original?.version || null, draft: { schema: target.schema, table: target.table, name: $('#trigger-name').value, timing: $('#trigger-timing').value, event: $('#trigger-event').value, body: $('#trigger-body').value } });
    renderSQLCode($('#trigger-review-sql'), review.sql); $('#trigger-review-sql').classList.remove('hidden');
    $('#trigger-editor-message').textContent = 'Revisa el SQL antes de aplicar.';
  });
  $('#apply-trigger').onclick = () => task(async () => {
    if (!review) return;
    await checkSession();
    const token = review.token; review = null;
    const result = await api.applyTrigger(token);
    if (result.applied) { dialog.close(); onChange(result.table); notify('Trigger aplicado.'); }
    else {
      $('#trigger-editor-message').textContent = `${result.error}${result.backupPath ? '\nCopia original: ' + result.backupPath : ''}`;
      if (result.restored) { onChange(result.table); original = await api.inspectTrigger(target.schema, original.name); }
    }
  });
  for (const id of ['#trigger-name', '#trigger-timing', '#trigger-event', '#trigger-body']) $(id).addEventListener('input', () => { review = null; $('#trigger-review-sql').classList.add('hidden'); controls(); });
  $('#cancel-trigger').onclick = () => { if (!pending) dialog.close(); };
  dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  return { open };
}
