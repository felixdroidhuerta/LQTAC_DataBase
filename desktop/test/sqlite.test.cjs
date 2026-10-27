const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SQLiteAdapter } = require('../src/adapters/sqlite.cjs');

test('SQL, schema, Unicode and exported copies survive round trip', async () => {
  const adapter = await SQLiteAdapter.open();
  let restored;
  try {
    adapter.execute("CREATE TABLE proyectos(id INTEGER PRIMARY KEY, nombre TEXT); INSERT INTO proyectos VALUES(1, 'Diseño LQTAC');");
    assert.deepEqual(adapter.schema(), [{ name: 'proyectos', type: 'table' }]);
    assert.deepEqual(adapter.execute('SELECT * FROM proyectos').results[0].values, [[1, 'Diseño LQTAC']]);
    restored = await SQLiteAdapter.fromBytes(adapter.export());
    assert.deepEqual(restored.execute('SELECT nombre FROM proyectos').results[0].values, [['Diseño LQTAC']]);
    assert.throws(() => adapter.execute('SELECT * FROM inexistente'), /no such table/);
    assert.equal(adapter.execute('SELECT 1').results[0].values[0][0], 1);
  } finally { adapter.close(); restored?.close(); }
});

test('large results are bounded and subsequent statements still run', async () => {
  const adapter = await SQLiteAdapter.open();
  try {
    const output = adapter.execute('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000) SELECT x FROM n; SELECT 42 AS answer;');
    assert.equal(output.results[0].values.length, 1000);
    assert.equal(output.results[0].truncated, true);
    assert.deepEqual(output.results[1].values, [[42]]);
    assert.throws(() => adapter.execute(' '), /consulta SQL/);
  } finally { adapter.close(); }
});
