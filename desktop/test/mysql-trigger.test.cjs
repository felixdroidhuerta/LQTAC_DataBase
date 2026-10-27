const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectTrigger, createTriggerSQL, replaceTrigger } = require('../src/mysql-trigger.cjs');
const { MySQLAdapter } = require('../src/adapters/mysql.cjs');
const { startMySQLFixture } = require('./mysql-fixture.cjs');

test('inspect, edit trigger and restore original definition on a CREATE error', async () => {
  const fixture = await startMySQLFixture(); let adapter;
  try {
    adapter = await MySQLAdapter.open(fixture.profile, 'fixture-test-password');
    const original = await inspectTrigger(adapter, 'test', 'audit_proyectos');
    assert.equal(original.definer, 'fixture@localhost');
    assert.equal(original.table, 'proyectos');
    const draft = { ...original, body: 'SET NEW.nombre = UPPER(NEW.nombre)' };
    assert.equal((await replaceTrigger(adapter, original, draft)).applied, true);
    const edited = await inspectTrigger(adapter, 'test', 'audit_proyectos');
    assert.equal(edited.body, draft.body);
    assert.notEqual(edited.version, original.version);
    const failed = await replaceTrigger(adapter, edited, { ...edited, body: 'INVALID_BODY' });
    assert.equal(failed.applied, false);
    assert.equal(failed.restored, true);
    assert.equal((await inspectTrigger(adapter, 'test', 'audit_proyectos')).body, draft.body);
    const drops = fixture.queries.filter(sql => sql.startsWith('DROP TRIGGER')).length;
    await assert.rejects(replaceTrigger(adapter, { ...edited, definer: 'another@localhost' }, draft), /definer/);
    assert.equal(fixture.queries.filter(sql => sql.startsWith('DROP TRIGGER')).length, drops);
  } finally { adapter?.close(); await fixture.close(); }
});
test('preserve definer and order, accept compound SQL, reject DELIMITER and invalid events', () => {
  const original = { schema: 'crm', table: 't', name: 'before_insert', timing: 'BEFORE', event: 'INSERT', definer: 'some@user@localhost', order: { kind: 'PRECEDES', name: 'next_trigger' }, body: 'BEGIN\nSET NEW.x=1;\nSET NEW.y=2;\nEND' };
  const sql = createTriggerSQL(original, original);
  assert.match(sql, /DEFINER=`some@user`@`localhost`/);
  assert.match(sql, /FOR EACH ROW PRECEDES `next_trigger`/);
  assert.match(sql, /SET NEW.x=1;\nSET NEW.y=2;/);
  assert.throws(() => createTriggerSQL({ ...original, event: 'DROP' }), /evento/);
  assert.throws(() => createTriggerSQL({ ...original, body: 'DELIMITER $$\nBEGIN END' }), /DELIMITER/);
  assert.throws(() => createTriggerSQL({ ...original, table: 'other' }, original), /tabla/);
});
