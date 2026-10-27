const { test } = require('node:test');
const assert = require('node:assert/strict');

test('SQL colors distinguish keywords, values, comments, types, identifiers and functions without changing source', async () => {
  const { tokenizeSQL } = await import('../src/renderer/sql-highlight.js');
  const source = "-- SELECT is a comment\nSELECT COUNT(*), nombre, 12.5e-2, 0xFF, 'a''b', `tabla` FROM crm WHERE id >= 3; /* UPDATE */\nCREATE TABLE t (id INT, text VARCHAR(20));";
  const tokens = tokenizeSQL(source);
  assert.equal(tokens.map(token => token.text).join(''), source);
  assert.equal(tokens.find(token => token.text === 'SELECT').type, 'keyword');
  assert.equal(tokens.find(token => token.text === 'COUNT').type, 'function');
  assert.equal(tokens.find(token => token.text === '12.5e-2').type, 'number');
  assert.equal(tokens.find(token => token.text === '0xFF').type, 'number');
  assert.equal(tokens.find(token => token.text === "'a''b'").type, 'string');
  assert.equal(tokens.find(token => token.text === '`tabla`').type, 'identifier');
  assert.equal(tokens.find(token => token.text === 'INT').type, 'type');
  assert.equal(tokens.find(token => token.text === '/* UPDATE */').type, 'comment');
});
test('quotes, unfinished input, comments, variables and dialects retain exact text', async () => {
  const { tokenizeSQL } = await import('../src/renderer/sql-highlight.js');
  for (const sql of ["SELECT 'unterminated", '/* unclosed comment', "SELECT 'á😀<img src=x>'", 'SELECT 1--2', 'SET @user = @@session.sql_mode;', "SELECT 'back\\'slash'", 'SELECT "a" FROM "table"\n', 'SELECT 1\r\n\tFROM t']) assert.equal(tokenizeSQL(sql).map(token => token.text).join(''), sql);
  assert.equal(tokenizeSQL('SELECT 1--2').some(token => token.type === 'comment'), false);
  assert.equal(tokenizeSQL('# comentario')[0].type, 'comment');
  assert.equal(tokenizeSQL('"tabla"', { dialect: 'sqlite' })[0].type, 'identifier');
  assert.equal(tokenizeSQL('"texto"')[0].type, 'string');
  assert.equal(tokenizeSQL('NEW.nombre')[0].type, 'variable');
});
