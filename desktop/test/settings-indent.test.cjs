const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore, executeTimed } = require('../src/settings.cjs');
test('settings validate bounds, survive restart and preserve the last saved value after invalid input', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lqtac-settings-'));
  try {
    const store = new SettingsStore(directory); assert.equal(store.get().queryTimeoutSeconds, 30);
    store.save({ queryTimeoutSeconds: 120 }); assert.equal(new SettingsStore(directory).get().queryTimeoutSeconds, 120);
    for (const invalid of [0, -1, 1.5, '60', NaN, 86401, null]) assert.throws(() => store.save({ queryTimeoutSeconds: invalid }));
    assert.equal(store.get().queryTimeoutSeconds, 120);
    fs.writeFileSync(path.join(directory, 'settings.json'), 'broken'); assert.equal(new SettingsStore(directory).get().queryTimeoutSeconds, 30);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('a slow cancellation keeps its connection open and occupied, passes native options and never retries writes', async () => {
  let calls = 0, closed = false, rejectQuery;
  const adapter = { alive: true, execute(sql, options) { calls++; assert.equal(sql, 'UPDATE test'); assert.equal(options.timeoutMs, 20); return new Promise((_, reject) => { rejectQuery = reject; }); }, cancelQuery() { return new Promise(resolve => setTimeout(() => { assert.equal(closed, false); rejectQuery(new Error('interrupted')); resolve(); }, 60)); }, close() { closed = true; } };
  await assert.rejects(executeTimed(adapter, 'mysql', 'UPDATE test', 20), {message:'Agotado tiempo máximo de consulta'});
  assert.ok(adapter.pendingExecution); assert.equal(closed, false); await adapter.pendingExecution.done;
  assert.equal(closed, false); assert.equal(adapter.alive, true); assert.equal(calls, 1);
  const fast = { execute: async (_sql, options) => options.timeoutMs, close() { throw new Error('A successful query must remain connected'); } };
  assert.equal(await executeTimed(fast, 'mysql', 'SELECT 1', 100), 100);
  await assert.rejects(executeTimed(fast, 'mysql', 'SELECT 1', 0));
});
test('indentation handles carets, forward/backward block ranges, exclusive final line and mixed existing whitespace', async () => {
  const { indentationEdit } = await import('../src/renderer/editor-indent.js');
  const apply = (source, start, end, out = false) => { const edit = indentationEdit(source, start, end, out); return { value: source.slice(0, edit.from) + edit.text + source.slice(edit.to), ...edit }; };
  assert.equal(apply('SELECT 1', 6, 6).value, 'SELECT\t 1');
  const indented = apply('SELECT\n  1;\nSELECT 2;', 0, 12);
  assert.equal(indented.value, '\tSELECT\n\t  1;\nSELECT 2;');
  const undone = apply(indented.value, indented.start, indented.end, true); assert.equal(undone.value, 'SELECT\n  1;\nSELECT 2;'); assert.equal(undone.end, 12);
  assert.equal(apply('\tfirst\n    second\n  third', 0, 26, true).value, 'first\nsecond\nthird');
  assert.equal(apply('\nSELECT 1', 0, 0).value, '\t\nSELECT 1');
  assert.equal(apply('  SELECT', 1, 1, true).start, 0);
});
