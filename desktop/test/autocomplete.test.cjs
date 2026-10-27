const { test } = require('node:test');
const assert = require('node:assert/strict');
const catalog = { engine: 'mysql', database: 'crmti', schemas: [
  { name: 'asterisk', objects: [{ name: 'lea_leads', type: 'table' }] },
  { name: 'crmti', objects: [{ name: 'lea_leads', type: 'table' }, { name: 'lea_log', type: 'view' }, { name: 'lea_proc', type: 'procedure' }, { name: 'weird`table', type: 'table' }] }
] };
test('table suggestions use local catalog, prioritize active database and qualify other schemas', async () => {
  const { getTableCompletions } = await import('../src/renderer/autocomplete.js');
  const sql = 'SELECT * FROM lea';
  const results = getTableCompletions(sql, sql.length, catalog);
  assert.deepEqual(results.map(item => [item.schema, item.name]), [['crmti', 'lea_leads'], ['crmti', 'lea_log'], ['asterisk', 'lea_leads']]);
  assert.equal(results[0].insert, '`lea_leads`');
  assert.equal(results[2].insert, '`asterisk`.`lea_leads`');
  assert.equal(sql.slice(0, results[0].from) + results[0].insert + sql.slice(results[0].to), 'SELECT * FROM `lea_leads`');
});
test('qualified names, joins, updates, inserts and replacement in the middle of a word', async () => {
  const { getTableCompletions } = await import('../src/renderer/autocomplete.js');
  for (const prefix of ['SELECT * FROM ', 'SELECT * FROM x JOIN ', 'UPDATE ', 'INSERT INTO ', 'DELETE FROM ']) {
    const sql = prefix + 'lea';
    assert.ok(getTableCompletions(sql, sql.length, catalog).length > 0);
  }
  const qualified = 'SELECT * FROM `asterisk`.lea';
  assert.deepEqual(getTableCompletions(qualified, qualified.length, catalog).map(item => item.insert), ['`lea_leads`']);
  const middle = 'SELECT * FROM lea_old WHERE 1=1';
  const item = getTableCompletions(middle, middle.indexOf('_old'), catalog)[0];
  assert.equal(middle.slice(0, item.from) + item.insert + middle.slice(item.to), 'SELECT * FROM `lea_leads` WHERE 1=1');
  const quoted = 'SELECT * FROM `lea_old` WHERE 1=1';
  const inside = getTableCompletions(quoted, quoted.indexOf('_old'), catalog)[0];
  assert.equal(quoted.slice(0, inside.from) + inside.insert + quoted.slice(inside.to), 'SELECT * FROM `lea_leads` WHERE 1=1');
});
test('ignore literals/comments, support explicit invocation and quote unusual names', async () => {
  const { getTableCompletions } = await import('../src/renderer/autocomplete.js');
  for (const sql of ["SELECT 'FROM lea", '-- SELECT * FROM lea', 'SELECT /* FROM lea', '# FROM lea']) assert.deepEqual(getTableCompletions(sql, sql.length, catalog, true), []);
  assert.deepEqual(getTableCompletions('SELECT lea', 10, catalog), []);
  assert.ok(getTableCompletions('SELECT ', 7, catalog, true).length > 0);
  assert.deepEqual(getTableCompletions('SELECT * FROM nonexistent.lea', 29, catalog), []);
  const weird = 'SELECT * FROM wei';
  assert.equal(getTableCompletions(weird, weird.length, catalog)[0].insert, '`weird``table`');
  const sqlite = { engine: 'sqlite', database: 'main', schemas: [{ name: 'main', objects: [{ name: 'proyectos', type: 'table' }] }] };
  const sql = 'SELECT * FROM pro';
  assert.equal(getTableCompletions(sql, sql.length, sqlite)[0].insert, '"proyectos"');
});
