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
  const exited = new Promise(resolve => child.once('exit', resolve));
  await Promise.race([evaluate('window.close()').catch(() => {}), exited]);
  await Promise.race([exited, delay(5000).then(() => { if (child.exitCode === null) child.kill(); })]);
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
    await evaluate('window.lqtac.demo()');
    const result = await evaluate('window.lqtac.execute("SELECT 42 AS portable", "local")');
    assert.equal(result.results[0].values[0][0], 42);
    await evaluate('localStorage.setItem("portable-smoke", "persisted")');
    await close(evaluate);
    assert.ok((await fs.readdir(data)).includes('Local Storage'));
    evaluate = await launch();
    for (let i = 0; i < 100 && !await evaluate('!!window.lqtac && document.readyState === "complete"'); i++) await delay(100);
    assert.equal(await evaluate('localStorage.getItem("portable-smoke")'), 'persisted');
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
