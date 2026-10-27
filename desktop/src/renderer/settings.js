export function initSettings({ api, notify }) {
  const dialog = document.createElement('dialog'); dialog.id = 'settings-dialog';
  dialog.innerHTML = '<form id="settings-form"><h2>Configuración</h2><label class="designer-field">Tiempo máximo de respuesta por consulta (segundos)<input id="query-timeout-seconds" type="number" min="1" max="86400" step="1" required></label><p class="designer-help">Se aplica a cada sentencia enviada a un servidor, incluidas las de un script. Valor inicial: 30 segundos. Los cambios se aplican al siguiente lanzamiento, sin reconectar. SQLite en memoria no utiliza este límite.</p><p class="designer-help">El servidor puede imponer un límite menor. Al agotarse la espera, una escritura puede haberse aplicado; comprueba su estado antes de repetirla.</p><p id="settings-error" role="alert"></p><div class="form-actions"><button type="button" id="reset-query-timeout" class="secondary">Restablecer 30 s</button><button type="button" id="close-settings" class="secondary">Cancelar</button><button type="submit" id="save-settings" class="primary">Guardar</button></div></form>';
  document.body.append(dialog);
  const toolbar = document.querySelector('.workspace-actions .mini-tools');
  const button = document.createElement('button'); button.id = 'open-settings'; button.className = 'mini-tool'; button.textContent = '⚙'; button.setAttribute('aria-label', 'Configuración'); button.dataset.hint = 'Configuración · Tiempo máximo de respuesta de las consultas'; toolbar.append(button);
  const input = dialog.querySelector('input'), error = dialog.querySelector('#settings-error');
  const indicator = document.createElement('span'); indicator.id = 'query-timeout-indicator'; indicator.title = 'Tiempo máximo por sentencia enviada al servidor. Se modifica en Configuración.'; document.querySelector('.editor-caption .heading-tools').append(indicator);
  let current = { queryTimeoutSeconds: 30 }, saving = false;
  const ready = api.getSettings().then(value => { current = value; indicator.textContent = `Límite: ${value.queryTimeoutSeconds} s`; }).catch(problem => { error.textContent = problem.message; notify('No se pudo cargar la configuración.'); });
  button.onclick = async () => { await ready; input.value = current.queryTimeoutSeconds; error.textContent = ''; dialog.showModal(); input.focus(); };
  dialog.querySelector('#close-settings').onclick = () => { if (!saving) dialog.close(); };
  dialog.querySelector('#reset-query-timeout').onclick = () => { input.value = 30; };
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.querySelector('form').onsubmit = async event => {
    event.preventDefault(); if (saving || !input.reportValidity()) return;
    saving = true; error.textContent = ''; dialog.querySelectorAll('button,input').forEach(node => { node.disabled = true; });
    try { current = await api.saveSettings({ queryTimeoutSeconds: Number(input.value) }); indicator.textContent = `Límite: ${current.queryTimeoutSeconds} s`; dialog.close(); notify('Configuración guardada. Se aplicará a las próximas consultas.'); }
    catch (problem) { error.textContent = problem.message; }
    finally { saving = false; dialog.querySelectorAll('button,input').forEach(node => { node.disabled = false; }); }
  };
}
