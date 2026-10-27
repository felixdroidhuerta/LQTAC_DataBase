const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { startMySQLFixture } = require('./mysql-fixture.cjs');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'lqtac-desktop-smoke-')));
require('../src/main.cjs');

const timeout = setTimeout(() => { console.error('Desktop smoke test timed out'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  const window = BrowserWindow.getAllWindows()[0];
  window.webContents.setBackgroundThrottling(false);
  const fixture = await startMySQLFixture();
  try {
    if (window.webContents.isLoading()) await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    const js = code => window.webContents.executeJavaScript(code);
    assert.equal(await js('document.querySelectorAll(".card").length'), 4);
    assert.equal(await js('document.querySelector(".brand img").naturalWidth > 0'), true);
    await js('document.querySelector("#new-connection-home").click()');
    assert.equal(await js('document.querySelector("#connection-dialog").open'), true);
    assert.equal(await js('document.querySelector("#connection-form").elements.port.value'), '5432');
    await js(`(() => {
      const form = document.querySelector('#connection-form');
      form.elements.engine.value = 'mysql';
      form.elements.engine.dispatchEvent(new Event('change'));
      form.elements.namedItem('name').value = 'Servidor de prueba';
      form.elements.host.value = 'localhost';
      form.elements.database.value = 'test';
      form.elements.username.value = 'test';
    })()`);
    assert.equal(await js('document.querySelector("#connection-form").elements.port.value'), '3306');
    await js(`document.querySelector('#connection-form').elements.port.value = ${fixture.profile.port}; document.querySelector('#connection-form').elements.host.value = '127.0.0.1'`);
    await js('document.querySelector("#connection-form").requestSubmit()');
    await js(`new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (document.querySelector('.profile-row')) return resolve();
        if (Date.now() - start > 10000) return reject(new Error('Profile save failed'));
        setTimeout(poll, 50);
      }; poll();
    })`);
    assert.equal(await js('document.querySelector(".profile-row h3").textContent'), 'Servidor de prueba');
    assert.match(await js('document.querySelector(".profile-row .pill").textContent'), /Sin conectar/);
    assert.equal((await js('window.lqtac.listConnections()')).length, 1);
    await js('document.querySelector(".profile-row button").click()');
    assert.equal(await js('document.querySelector("#connection-form").elements.database.value'), 'test');
    await js('document.querySelector("#cancel-profile").click()');
    await js('document.querySelector(".profile-row .primary").click()');
    await js(`new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(document.querySelector('#credentials-dialog').open)return resolve();if(Date.now()-start>5000)return reject(new Error('Credentials did not open'));setTimeout(poll,30)};poll()})`);
    assert.equal(await js('document.querySelector("#credentials-dialog").open'), true);
    await js(`document.querySelector('#connection-password').value = 'fixture-test-password'; document.querySelector('#test-connection').click()`);
    await js(`new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (document.querySelector('#credentials-message').textContent.startsWith('Conexión correcta')) return resolve();
        if (Date.now() - start > 10000) return reject(new Error('Connection test failed'));
        setTimeout(poll, 50);
      }; poll();
    })`);
    assert.equal(await js('(async () => (await window.lqtac.status()).connected)()'), false);
    await js('document.querySelector("#credentials-form").requestSubmit()');
    await js(`new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (document.querySelector('#connection-label').textContent === 'Servidor de prueba') return resolve();
        if (Date.now() - start > 10000) return reject(new Error('MySQL connection failed'));
        setTimeout(poll, 50);
      }; poll();
    })`);
    assert.equal(await js('document.querySelector("#connection-password").value'), '');
    assert.equal(await js('document.querySelector("#sql-dialect").textContent'), 'SQL / MySQL');
    assert.equal(await js('document.querySelector("#export-db").classList.contains("hidden")'), true);
    await js('document.querySelector("#run-query").click()');
    await js(`new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (document.querySelector('#results tbody tr')) return resolve();
        if (Date.now() - start > 10000) return reject(new Error('MySQL query failed'));
        setTimeout(poll, 50);
      }; poll();
    })`);
    assert.equal(await js('document.querySelector("#results tbody td").textContent'), 'test');
    console.log('Desktop: remote SQL ready');
    const beforeCompletion = fixture.queries.length;
    await js(`(() => {
      const editor = document.querySelector('#query');
      editor.value = 'SELECT * FROM pro'; editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length);
      editor.dispatchEvent(new Event('input'));
    })()`);
    assert.equal(await js('document.querySelectorAll(".completion-option").length'), 2);
    assert.match(await js('document.querySelector(".completion-option small").textContent'), /^test/);
    await js(`document.querySelector('#query').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true, cancelable:true})); document.querySelector('#query').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));`);
    assert.equal(await js('document.querySelector("#query").value'), 'SELECT * FROM `asterisk`.`proyectos`');
    assert.equal(await js('document.querySelector("#table-completions").classList.contains("hidden")'), true);
    console.log('Desktop: autocomplete acceptance ready');
    assert.equal(fixture.queries.length, beforeCompletion);
    await js(`(() => {
      const editor = document.querySelector('#query'); editor.value = 'SELECT * FROM test.pr'; editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); editor.dispatchEvent(new Event('input'));
      editor.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', bubbles:true, cancelable:true}));
    })()`);
    assert.equal(await js('document.querySelector("#query").value'), 'SELECT * FROM test.`proyectos`');
    await js(`(() => {
      const editor = document.querySelector('#query'); editor.value = 'SELECT * FROM '; editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length);
      editor.dispatchEvent(new KeyboardEvent('keydown', {key:' ',code:'Space',ctrlKey:true,bubbles:true,cancelable:true}));
    })()`);
    assert.ok(await js('document.querySelectorAll(".completion-option").length > 0'));
    await js(`document.querySelector('#query').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true}))`);
    assert.equal(await js('document.querySelector("#table-completions").classList.contains("hidden")'), true);
    console.log('Desktop: autocomplete shortcuts ready');
    assert.equal(await js('document.querySelectorAll(".schema-tree").length'), 3);
    console.log('Desktop: schema count ready');
    assert.equal(await js('document.querySelector("#explorer").scrollHeight > document.querySelector("#explorer").clientHeight'), false);
    await js('document.querySelector(".tree-object[data-schema=test][data-object=proyectos]").click()');
    console.log('Desktop: table query ready');
    assert.match(await js('document.querySelector("#query").value'), /`proyectos`/);
    assert.match(await js('document.querySelector("#query").value'), /`test`\.`proyectos`/);
    await js(`document.querySelector('#explorer-filter').value = 'tabla_1099'; document.querySelector('#explorer-filter').dispatchEvent(new Event('input'))`);
    assert.equal(await js('document.querySelectorAll(".tree-object").length'), 1);
    assert.equal(await js('document.querySelector(".schema-name").textContent'), 'asterisk');
    console.log('Desktop: schema filter ready');
    await js(`document.querySelector('#explorer-filter').value = ''; document.querySelector('#explorer-filter').dispatchEvent(new Event('input')); document.querySelector('.schema-tree .select-database').click()`);
    await js(`new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (document.querySelector('#active-database').textContent === 'Base: asterisk') return resolve();
        if (Date.now() - start > 10000) return reject(new Error('Select database failed'));
        setTimeout(poll, 50);
      }; poll();
    })`);
    assert.equal(await js('document.querySelectorAll("#explorer .tree-object[data-schema=asterisk]").length'), 1101);
    assert.equal(await js('document.querySelector("#explorer").scrollHeight > document.querySelector("#explorer").clientHeight'), true);
    await js('document.querySelector("#demo-home").click()');
    await js('document.querySelector("#confirm-switch").click()');
    await js(`new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (document.querySelector('#connection-label').textContent === 'Laboratorio LQTAC') return resolve();
        if (Date.now() - start > 10000) return reject(new Error('Demo connection failed'));
        setTimeout(poll, 50);
      }; poll();
    })`);
    await js('document.querySelector("#run-query").click()');
    await js(`new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (document.querySelector('#results tbody tr')) return resolve();
        if (Date.now() - start > 10000) return reject(new Error('SQL execution failed'));
        setTimeout(poll, 50);
      }; poll();
    })`);
    assert.equal(await js('document.querySelectorAll("#results tbody tr").length'), 3);
    assert.equal(await js('document.querySelector("#results tbody tr td:nth-child(2)").textContent'), 'LQTAC Data Base');
    assert.equal(await js('document.querySelectorAll(".connection-entry[data-connection-id=local] .tree-object").length'), 2);
    assert.equal(await js('Boolean(window.lqtac) && typeof window.require === "undefined"'), true);
    await js(`(() => {
      const columns = Array.from({length: 64}, (_, i) => {
        const value = i === 0 ? 'texto largo '.repeat(80) : 'valor_' + i;
        return "'" + value + "' AS lea_columna_extensa_" + i;
      });
      const editor = document.querySelector('#query');
      editor.value = 'SELECT ' + columns.join(', ');
      editor.dispatchEvent(new Event('input'));
      document.querySelector('#run-query').click();
    })()`);
    await js(`new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (document.querySelectorAll('#results th').length === 64) return resolve();
        if (Date.now() - start > 10000) return reject(new Error('Wide results not rendered'));
        setTimeout(poll, 50);
      }; poll();
    })`);
    const gridMetrics = await js(`(() => {
      const grid = document.querySelector('#results');
      const header = grid.querySelector('thead');
      grid.scrollLeft = grid.scrollWidth;
      return {
        horizontalScroll: grid.scrollWidth > grid.clientWidth,
        canReachLastColumn: grid.scrollLeft > 0,
        headerHeight: header.getBoundingClientRect().height,
        rowHeight: grid.querySelector('tbody tr').getBoundingClientRect().height,
        headerWrap: getComputedStyle(grid.querySelector('th')).whiteSpace,
        valueWrap: getComputedStyle(grid.querySelector('.cell-value')).whiteSpace,
        originalValue: grid.querySelector('.cell-value').title,
        noPageOverflow: document.body.scrollWidth <= innerWidth
      };
    })()`);
    assert.equal(gridMetrics.horizontalScroll, true);
    assert.equal(gridMetrics.canReachLastColumn, true);
    assert.equal(gridMetrics.headerWrap, 'nowrap');
    assert.equal(gridMetrics.valueWrap, 'nowrap');
    assert.ok(gridMetrics.headerHeight < 45);
    assert.ok(gridMetrics.rowHeight < 45);
    assert.equal(gridMetrics.originalValue, 'texto largo '.repeat(80));
    assert.equal(gridMetrics.noPageOverflow, true);
    await js(`document.querySelector('#wrap-results').click()`);
    assert.equal(await js('getComputedStyle(document.querySelector("#results .cell-value")).whiteSpace'), 'pre-wrap');
    assert.equal(await js('getComputedStyle(document.querySelector("#results th")).whiteSpace'), 'nowrap');
    assert.ok(await js('document.querySelector("#results tbody tr").getBoundingClientRect().height > 45'));
    await js(`document.querySelector('#wrap-results').click()`);
    window.setSize(1000, 680);
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await js('document.querySelector("#results").scrollWidth > document.querySelector("#results").clientWidth'), true);
    assert.ok(await js('document.querySelector("#results thead").getBoundingClientRect().height < 45'));
    const tabsBeforeClose = await js('document.querySelectorAll(".query-tab").length');
    console.log('Desktop: grid ready, closing tabs');
    const currentDraft = await js('document.querySelector("#query").value');
    await js('document.querySelector(".query-tab:not(.active) .tab-close").click()');
    assert.equal(await js('document.querySelectorAll(".query-tab").length'), tabsBeforeClose - 1);
    assert.equal(await js('document.querySelector("#query").value'), currentDraft);
    await js('document.querySelector(".query-tab.active .tab-close").click()');
    assert.equal(await js('document.querySelectorAll(".query-tab").length'), tabsBeforeClose - 2);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'T',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))`);
    assert.equal(await js('document.querySelector("#query").value'), currentDraft);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'w',ctrlKey:true,bubbles:true,cancelable:true}))`);
    assert.equal(await js('document.querySelectorAll(".query-tab").length'), tabsBeforeClose - 2);
    await js(`for(let i=0;i<30 && document.querySelector('.tab-close');i++) document.querySelector('.tab-close').click()`);
    assert.equal(await js('document.querySelectorAll(".query-tab").length'), 0);
    assert.equal(await js('document.querySelector("#home").classList.contains("hidden")'), false);
    assert.deepEqual(await js('JSON.parse(localStorage.getItem("lqtac.queries"))'), []);
    assert.equal(await js('(async () => (await window.lqtac.status()).connected)()'), true);
    await js(`document.querySelector('[data-view=sql].nav').click()`);
    assert.equal(await js('document.querySelectorAll(".query-tab").length'), 1);
    assert.equal(await js('document.querySelector("#sql").classList.contains("hidden")'), false);
    await fixture.close();
    console.log('PASS: tab close/recover/last tab, autocomplete typing/arrows/Enter/Tab/Ctrl+Space/Escape, grid, schemas, MySQL and SQLite');
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) { console.error(error); await fixture.close(); clearTimeout(timeout); app.exit(1); }
});
