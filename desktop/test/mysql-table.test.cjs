const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectTable, buildTablePlan, literal, defaultFromDefinition, columnSQL, splitDefinitions } = require('../src/mysql-table.cjs');
const { MySQLAdapter } = require('../src/adapters/mysql.cjs');
const { startMySQLFixture } = require('./mysql-fixture.cjs');
const blank = name => ({ originalName: '', name, type: 'TEXT', nullable: true, unsigned: false, zerofill: false, binary: false, autoIncrement: false, defaultKind: 'none', defaultValue: '', comment: '', charset: '', collation: '', generated: '', generatedStorage: 'VIRTUAL', onUpdate: '', invisible: false });

test('inspect reads exact defaults, attributes, DDL and indexes; plans are read-only until executed', async () => {
  const fixture = await startMySQLFixture(); let adapter;
  try {
    adapter = await MySQLAdapter.open(fixture.profile, 'fixture-test-password');
    const snapshot = await inspectTable(adapter, 'test', 'proyectos');
    assert.equal(snapshot.columns.length, 2);
    assert.equal(snapshot.columns[0].autoIncrement, true);
    assert.equal(snapshot.columns[0].unsigned, true);
    assert.equal(snapshot.columns[1].defaultValue, "''");
    assert.equal(snapshot.columns[1].comment, 'Título');
    assert.equal(snapshot.indexes[0].kind, 'PRIMARY');
    assert.throws(() => buildTablePlan(snapshot, structuredClone(snapshot)), /No hay cambios/);
    const draft = structuredClone(snapshot);
    draft.columns.push(blank('notas'));
    const plan = buildTablePlan(snapshot, draft);
    assert.match(plan.sql, /ALTER TABLE `test`\.`proyectos`/);
    assert.match(plan.sql, /ADD COLUMN `notas` TEXT NULL AFTER `nombre`/);
    assert.doesNotMatch(plan.sql, /CHANGE COLUMN|DROP|PRIMARY KEY/);
    assert.equal(fixture.queries.some(sql => sql.startsWith('ALTER TABLE')), false);
    const rename = structuredClone(snapshot);
    rename.columns[1].name = 'nombre_nuevo';
    rename.columns[1].comment = "Título d'ejemplo";
    const renameSQL = buildTablePlan(snapshot, rename).sql;
    assert.match(renameSQL, /CHANGE COLUMN `nombre` `nombre_nuevo` varchar\(255\)/);
    assert.match(renameSQL, /NOT NULL DEFAULT '' COMMENT 'Título d''ejemplo'/);
    assert.doesNotMatch(renameSQL, /DROP COLUMN|DROP PRIMARY/);
    const drop = structuredClone(snapshot); drop.columns.pop();
    const dropping = buildTablePlan(snapshot, drop);
    assert.match(dropping.sql, /DROP COLUMN `nombre`/);
    assert.ok(dropping.warnings.some(text => text.includes('sus datos')));
    const properties = structuredClone(snapshot); properties.name = 'renombrada'; properties.comment = 'Nuevo comentario';
    const propertiesSQL = buildTablePlan(snapshot, properties).sql;
    assert.match(propertiesSQL, /COMMENT = 'Nuevo comentario'/);
    assert.match(propertiesSQL, /RENAME TO `test`\.`renombrada`/);
    assert.doesNotMatch(propertiesSQL, /CHANGE COLUMN|DROP|ADD COLUMN/);
    fixture.simulateInsert();
    assert.equal((await inspectTable(adapter, 'test', 'proyectos')).version, snapshot.version, 'Concurrent inserts must not look like schema edits');
    fixture.changeDefinition();
    assert.notEqual((await inspectTable(adapter, 'test', 'proyectos')).version, snapshot.version);
  } finally { adapter?.close(); await fixture.close(); }
});
test('plans preserve untouched attributes and create columns, composite indexes and foreign keys', () => {
  const draft = { schema: 'crmti', name: 'act_action', engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_general_ci', comment: "Acción d'ejemplo", columns: [
    { ...blank('id'), type: 'INT', nullable: false, unsigned: true, autoIncrement: true },
    { ...blank('description'), type: 'VARCHAR(255)', nullable: false, defaultKind: 'value', defaultValue: '' },
    { ...blank('parent_id'), type: 'INT', unsigned: true }
  ], indexes: [
    { name: 'PRIMARY', kind: 'PRIMARY', method: 'BTREE', columns: [{ name: 'id', prefix: 0, order: 'ASC' }], visible: true },
    { name: 'idx_parent_description', kind: 'INDEX', method: 'BTREE', columns: [{ name: 'parent_id', prefix: 0, order: 'ASC' }, { name: 'description', prefix: 25, order: 'DESC' }], visible: true }
  ], foreignKeys: [{ name: 'fk_parent', columns: ['parent_id'], referencedSchema: 'crmti', referencedTable: 'parent', referencedColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' }] };
  const plan = buildTablePlan(null, draft);
  assert.match(plan.sql, /CREATE TABLE `crmti`\.`act_action`/);
  assert.match(plan.sql, /`id` INT UNSIGNED NOT NULL AUTO_INCREMENT/);
  assert.match(plan.sql, /DEFAULT ''/);
  assert.match(plan.sql, /`description`\(25\) DESC/);
  assert.match(plan.sql, /ON DELETE SET NULL ON UPDATE CASCADE/);
  assert.match(plan.sql, /COMMENT = 'Acción d''ejemplo'/);
});
test('default parser ignores comments, nested commas and table options after the body', () => {
  assert.deepEqual(defaultFromDefinition("varchar(20) COMMENT 'DEFAULT 123'"), { defaultKind: 'none', defaultValue: '' });
  assert.equal(defaultFromDefinition("varchar(50) DEFAULT 'a b, c' COMMENT 'DEFAULT z'").defaultValue, "'a b, c'");
  assert.equal(defaultFromDefinition("json DEFAULT (json_object('x', 1, 'y', (2 + 3))) COMMENT 'ok'").defaultValue, "(json_object('x', 1, 'y', (2 + 3)))");
  assert.equal(defaultFromDefinition('timestamp DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)').defaultValue, 'CURRENT_TIMESTAMP(6)');
  assert.equal(defaultFromDefinition("varchar(20) DEFAULT 'a\\' COMMENT 'text'", 'NO_BACKSLASH_ESCAPES').defaultValue, "'a\\'");
  assert.equal(splitDefinitions("`x` enum('a,b','c'), `y` decimal(10,2), PRIMARY KEY (`x`,`y`)").length, 3);
  assert.equal(literal("a\\b'c", 'NO_BACKSLASH_ESCAPES'), "'a\\b''c'");
});
test('invalid SQL fragments, types and incompatible flags are rejected before any DDL', () => {
  assert.throws(() => columnSQL({ ...blank('x'), type: 'INT; DROP TABLE t' }), /Tipo de dato/);
  assert.throws(() => columnSQL({ ...blank('x'), unsigned: true }), /numérico/);
  assert.throws(() => columnSQL({ ...blank('x'), type: 'INT', autoIncrement: true }), /AUTO_INCREMENT/);
  assert.throws(() => columnSQL({ ...blank('x'), defaultKind: 'sql', defaultValue: '1); DROP TABLE t;' }), /equilibrados|separadores/);
  assert.throws(() => columnSQL({ ...blank('x'), generated: 'a+1', generatedStorage: 'STORED', defaultKind: 'value', defaultValue: '2' }), /generada/);
  assert.match(columnSQL({ ...blank('x'), type: "ENUM('one','two')" }), /ENUM/);
});
