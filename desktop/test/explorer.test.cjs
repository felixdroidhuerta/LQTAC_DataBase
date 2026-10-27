const { test } = require('node:test');
const assert = require('node:assert/strict');

test('queries qualify the schema and safely quote identifiers; routines open definitions', async () => {
  const { objectQuery } = await import('../src/renderer/explorer.js');
  assert.equal(objectQuery('asterisk', { name: 'proyectos', type: 'table' }, true), 'SELECT * FROM `asterisk`.`proyectos` LIMIT 100;');
  assert.equal(objectQuery('a`b', { name: 'x`y', type: 'view' }, true), 'SELECT * FROM `a``b`.`x``y` LIMIT 100;');
  assert.equal(objectQuery('crm', { name: 'proc', type: 'procedure' }, true), 'SHOW CREATE PROCEDURE `crm`.`proc`;');
  assert.equal(objectQuery('crm', { name: 'calc', type: 'function' }, true), 'SHOW CREATE FUNCTION `crm`.`calc`;');
  assert.equal(objectQuery('main', { name: 'x"y', type: 'table' }, false), 'SELECT * FROM "main"."x""y" LIMIT 100;');
});
