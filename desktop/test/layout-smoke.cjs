const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'lqtac-layout-smoke-')));
require('../src/main.cjs');

const timeout = setTimeout(() => { console.error('Layout test timed out'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  const window = BrowserWindow.getAllWindows()[0];
  window.webContents.setBackgroundThrottling(false);
  const js = code => window.webContents.executeJavaScript(code);
  const settled = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const metrics = () => js(`({
    sidebar: document.querySelector('#sidebar').getBoundingClientRect().width,
    navigation: document.querySelector('#workspace-navigation').getBoundingClientRect().height,
    editor: document.querySelector('.query-editor').getBoundingClientRect().height,
    results: document.querySelector('#results').clientHeight,
    noOverflow: document.body.scrollWidth <= innerWidth,
    saved: JSON.parse(localStorage.getItem('lqtac.panelLayout'))
  })`);
  async function drag(selector, dx, dy) {
    const point = await js(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + dx, y: point.y + dy, button: 'left' });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + dx, y: point.y + dy, button: 'left', clickCount: 1 });
    await settled();
  }
  try {
    if (window.webContents.isLoading()) await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    assert.equal(await js('document.querySelector("#workspace-panel").open'), false);
    await js('document.querySelector("#workspace-panel").open = true');
    await js(`document.querySelector('.nav[data-view=sql]').click()`);
    await settled();
    const initial = await metrics();
    await drag('#sidebar-splitter', 85, 0);
    const wider = await metrics();
    assert.ok(wider.sidebar >= initial.sidebar + 70, 'Sidebar must follow horizontal drag');
    assert.ok(wider.noOverflow);
    await drag('#navigation-splitter', 0, 65);
    const shorter = await metrics();
    assert.ok(shorter.navigation <= initial.navigation - 50, 'Navigation must follow vertical drag');
    const beforeEditor = shorter.editor;
    await drag('#editor-splitter', 0, 75);
    const taller = await metrics();
    assert.ok(taller.editor >= beforeEditor + 60, 'Editor must follow vertical drag');
    assert.ok(taller.results >= 80);
    assert.ok(taller.saved.sidebarWidth > initial.sidebar);
    const restoredLoad = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    window.webContents.reload(); await restoredLoad;
    await js(`document.querySelector('.nav[data-view=sql]').click()`); await settled();
    const restored = await metrics();
    assert.ok(Math.abs(restored.sidebar - taller.sidebar) <= 1);
    assert.ok(Math.abs(restored.navigation - taller.navigation) <= 1);
    assert.ok(Math.abs(restored.editor - taller.editor) <= 2);
    for (const selector of ['#sidebar-splitter', '#navigation-splitter', '#editor-splitter']) {
      await js(`document.querySelector('${selector}').dispatchEvent(new KeyboardEvent('keydown', {key:'End',bubbles:true,cancelable:true}))`);
      await settled();
      assert.equal(await js(`document.querySelector('${selector}').getAttribute('aria-valuenow')`), await js(`document.querySelector('${selector}').getAttribute('aria-valuemax')`));
      await js(`document.querySelector('${selector}').dispatchEvent(new KeyboardEvent('keydown', {key:'Home',bubbles:true,cancelable:true}))`);
      await settled();
      assert.equal(await js(`document.querySelector('${selector}').getAttribute('aria-valuenow')`), await js(`document.querySelector('${selector}').getAttribute('aria-valuemin')`));
      await js(`document.querySelector('${selector}').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
      await settled();
    }
    const reset = await metrics();
    assert.ok(Math.abs(reset.sidebar - initial.sidebar) <= 1);
    assert.ok(Math.abs(reset.navigation - initial.navigation) <= 1);
    window.setSize(1000, 680); await settled();
    const small = await metrics();
    assert.ok(small.noOverflow);
    assert.ok(small.editor >= 79 && small.results >= 79, 'Keep both editor and results usable');
    assert.equal(await js('document.body.classList.contains("resizing-panels")'), false);
    console.log('PASS: three real pointer drags, layout persistence after reload, keyboard limits, reset and small-window bounds');
    clearTimeout(timeout); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
});
