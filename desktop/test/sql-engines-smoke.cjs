const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { installDriverFixtures, startPostgresFixture } = require('./sql-engines-fixture.cjs');
const drivers = installDriverFixtures();
app.setPath('userData', mkdtempSync(join(tmpdir(), 'lqtac-sql-engines-')));
require('../src/main.cjs');
const timeout = setTimeout(() => { console.error('SQL engines smoke timed out'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false);
  const postgres = await startPostgresFixture();
  try {
    if (window.webContents.isLoading()) await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    const js = code => window.webContents.executeJavaScript(code);
    const until = condition => js(`new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(${condition})return resolve();if(Date.now()-start>8000)return reject(new Error(${JSON.stringify(condition)}));setTimeout(poll,30)};poll()})`);
    const profiles = [postgres.profile, { name: 'SQL Server fixture', engine: 'sqlserver', host: 'localhost', port: 1433, username: 'sa', database: 'lqtac' }, { name: 'Oracle fixture', engine: 'oracle', host: 'localhost', port: 1521, username: 'HR', database: 'FREEPDB1' }];
    await js('document.querySelector("#new-connection-home").click()');
    assert.equal(await js(`[...document.querySelector('#connection-form').elements.engine.options].some(option=>option.textContent.includes('pendiente'))`), false);
    for (const profile of profiles) {
      await js(`document.querySelector('#connection-form').elements.engine.value=${JSON.stringify(profile.engine)};document.querySelector('#connection-form').elements.engine.dispatchEvent(new Event('change'))`);
      assert.equal(Number(await js(`document.querySelector('#connection-form').elements.port.value`)), { postgresql: 5432, sqlserver: 1433, oracle: 1521 }[profile.engine]);
      assert.equal(await js('document.querySelector("#connection-form").elements.database.required'), profile.engine === 'oracle');
      await js(`window.lqtac.saveConnection(${JSON.stringify(profile)})`);
    }
    assert.match(await js('document.querySelector("#database-field-label").textContent'), /SERVICE_NAME/);
    await js('document.querySelector("#cancel-profile").click()');
    for (const profile of profiles) {
      await js('document.querySelector("[data-view=connections]").click()');
      await until('document.querySelectorAll(".profile-row").length===3');
      await js(`[...document.querySelectorAll('.profile-row')].find(row=>row.querySelector('h3').textContent===${JSON.stringify(profile.name)}).querySelector('.primary').click()`);
      await until('document.querySelector("#credentials-dialog").open');
      await js(`document.querySelector('#connection-password').value='test-only';document.querySelector('#test-connection').click()`);
      await until(`document.querySelector('#credentials-message').textContent.includes('Conexión correcta')`);
      await js('document.querySelector("#credentials-form").requestSubmit()');
      await until(`document.querySelector('#connection-label').textContent===${JSON.stringify(profile.name)} && !document.querySelector('#credentials-dialog').open`);
      assert.match(await js('document.querySelector("#active-database").textContent'), /Esquema:.*Base\/servicio:/);
      assert.doesNotMatch(await js('document.querySelector("#query").value'), /SELECT DATABASE\(\)/);
      if (profile.engine === 'oracle') assert.match(await js('document.querySelector("#execution-note").textContent'), /COMMIT/);
      await js('document.querySelector("#run-query").click()'); await until('document.querySelector("#results tbody td")');
      assert.doesNotMatch(await js('document.querySelector("#query-info").textContent'), /Error/);
      const snapshot = await js('window.lqtac.status()'); const object = snapshot.schemas.flatMap(schema => schema.objects.map(object => ({ schema: schema.name, ...object }))).find(object => object.type === 'table');
      const query = await js(`import('./explorer.js').then(module=>module.objectQuery(${JSON.stringify(object.schema)},${JSON.stringify(object)},${JSON.stringify(profile.engine)}))`);
      if (profile.engine === 'sqlserver') assert.match(query, /SELECT TOP \(100\)/);
      if (profile.engine === 'oracle') assert.match(query, /FETCH FIRST 100 ROWS ONLY/);
      await js(`document.querySelector('#query').value=${JSON.stringify(query)};document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#run-query').click()`);
      await until('document.querySelector("#results tbody")?.textContent.includes("Ana")');
      if (profile.engine !== 'sqlserver') {
        const target = profile.engine === 'oracle' ? 'SALES' : 'sales';
        await js(`window.lqtac.selectDatabase(${JSON.stringify(target)})`);
        assert.equal((await js('window.lqtac.status()')).database, target);
      }
    }
    assert.equal((await js('window.lqtac.connectionOverview()')).sessions.filter(item => item.connected).length, 3);
    assert.equal(drivers.sqlConnections.every(connection => connection.config.authentication.type === 'default'), true);
    console.log('PASS: all selector engines available; PostgreSQL wire protocol, SQL Server/Oracle driver doubles, test/connect, schemas, native queries, results and independent sessions in Electron');
    clearTimeout(timeout); await postgres.close(); drivers.restore(); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(timeout); await postgres.close(); drivers.restore(); app.exit(1); }
});
