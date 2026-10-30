const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const directory = path.resolve(__dirname, '../../..', `LQTAC-DataBase-${require('../package.json').version}-win-${process.arch}-portable`);
const data = path.join(directory, 'Data');
let child, socket;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function launch() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  child = spawn(path.join(directory, 'LQTAC Data Base.exe'), [`--remote-debugging-port=${port}`, '--disable-features=CalculateNativeWinOcclusion'], { windowsHide: true, stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page' && item.url.endsWith('index.html')); } catch {}
    if (target) break;
    if (child.exitCode !== null) throw new Error('El ejecutable terminó antes de cargar.');
    await delay(150);
  }
  assert.ok(target, 'El ejecutable debe cargar la interfaz empaquetada');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => { const result = JSON.parse(event.data); if (pending.has(result.id)) { pending.get(result.id)(result); pending.delete(result.id); } };
  return async expression => {
    const current = ++id;
    const response = new Promise(resolve => pending.set(current, resolve));
    socket.send(JSON.stringify({ id: current, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    const result = await response;
    if (result.error || result.result.exceptionDetails) throw new Error(JSON.stringify(result));
    return result.result.result.value;
  };
}
async function close(evaluate) {
  const closingChild = child;
  const exited = new Promise(resolve => closingChild.once('exit', resolve));
  await Promise.race([evaluate('window.close()').catch(() => {}), exited]);
  await Promise.race([exited, delay(5000).then(() => { if (closingChild.exitCode === null) closingChild.kill(); })]);
  socket.close();
}
async function run() {
  try { await fs.access(data); throw new Error('La prueba exige una carpeta portable nueva sin Data para proteger los datos existentes.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let ownedData = false;
  try {
    let evaluate = await launch();
    ownedData = true;
    for (let i = 0; i < 100 && !await evaluate('document.readyState === "complete" && !!window.lqtac && document.querySelector(".brand img")?.naturalWidth > 0'); i++) await delay(100);
    assert.equal(await evaluate('document.querySelector(".brand img").naturalWidth > 0'), true);
    assert.deepEqual(await evaluate('window.lqtac.listConnections()'), []);
    assert.equal(await evaluate('document.querySelector("footer b").textContent'),require('../package.json').version);
    assert.ok((await fs.stat(path.join(directory,'Manual-de-usuario-0.2.0.pdf'))).size>1000);
    assert.equal(await evaluate('typeof window.lqtac.prepareDashboardImport'), 'function');
    assert.equal(await evaluate('typeof window.lqtac.exportDashboard'), 'function');
    assert.equal(await evaluate('document.querySelector("#result-limit option[value=" + CSS.escape("0") + "]")?.textContent'), 'Sin límite');
    assert.equal(await evaluate('document.querySelector(".brand-wordmark-light").naturalWidth > 0'), true);
    assert.equal(await evaluate('document.querySelector("#stop-query")?.disabled'), true);
    assert.equal(await evaluate('document.querySelectorAll(".editor-caption .tool-group").length'), 4);
    assert.equal(await evaluate('document.querySelector("#edit-result-data")?.disabled'), true);
    assert.equal(await evaluate('document.querySelector("#apply-result-data")?.disabled'), true);
    assert.equal((await evaluate('window.lqtac.getSettings()')).queryTimeoutSeconds, 30);
    await evaluate('window.lqtac.saveSettings({queryTimeoutSeconds:90})');
    await evaluate('window.lqtac.demo()');
    const result = await evaluate('window.lqtac.execute("SELECT 42 AS portable", "local")');
    assert.equal(result.results[0].values[0][0], 42);
    const unlimited = await evaluate('window.lqtac.execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1500) SELECT x FROM n", "local", 0)');
    assert.equal(unlimited.results[0].values.length, 1500);
    assert.equal(unlimited.results[0].truncated, false);
    const formula=await evaluate("(async()=>{const f=await import('./dashboard-formulas.mjs');return f.evaluateFormula(f.parseFormula('SEC_TO_TIME(TIME_TO_SEC([0])+60)',1),{row:['01:00:00']})})()");
    assert.equal(formula,'01:01:00');
    const token=unlimited.exportToken;
    await evaluate('window.lqtac.rememberDashboardQuery("portable-query",'+JSON.stringify(token)+')');
    await evaluate('window.lqtac.renameResult('+JSON.stringify(token)+',0,"Respuesta portable")');
    await evaluate('window.lqtac.execute("SELECT 99", "local")');
    const sources=await evaluate('window.lqtac.captureDashboardResults('+JSON.stringify(token)+',[0])');
    assert.equal(sources[0].rows.length,1500);assert.equal(sources[0].name,'Respuesta portable');
    await evaluate('window.lqtac.saveDashboard('+JSON.stringify({format:'LQTAC Dashboard',version:1,id:'portable-dashboard-test',revision:0,name:'Portable dashboard test',datasets:sources,widgets:[]})+')');
    await evaluate('localStorage.setItem("portable-smoke", "persisted")');
    await close(evaluate);
    assert.ok((await fs.readdir(data)).includes('Local Storage'));
    evaluate = await launch();
    for (let i = 0; i < 100 && !await evaluate('!!window.lqtac && document.readyState === "complete"'); i++) await delay(100);
    assert.equal(await evaluate('localStorage.getItem("portable-smoke")'), 'persisted');
    assert.equal((await evaluate('window.lqtac.getSettings()')).queryTimeoutSeconds, 90);
    const board=await evaluate('window.lqtac.openDashboard("portable-dashboard-test")');assert.equal(board.datasets[0].rows.length,1500);assert.equal(board.datasets[0].source.rowLimit,0);
    assert.equal((await evaluate('window.lqtac.listConnections()')).length,0);
    await close(evaluate);
    console.log('PASS: ejecutable autónomo, logo, dependencias SQLite/WASM, perfiles vacíos y preferencias persistentes en Data tras reiniciar');
  } finally {
    if (child?.exitCode === null) { child.kill(); await delay(1500); }
    socket?.close();
    // Only remove the exact test-owned Data folder of this fresh build, never an existing workspace.
    if (ownedData && path.dirname(data) === directory && path.basename(data) === 'Data') await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
