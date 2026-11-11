const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MySQLAdapter } = require('../src/adapters/mysql.cjs');

function fixture() {
  const connection = new EventEmitter();
  connection.stream = new EventEmitter();
  connection.stream.destroyed = false;
  return { connection, adapter: new MySQLAdapter(connection, {}) };
}

test('MySQL detecta el cierre del socket y del protocolo', () => {
  for (const close of [
    c => c.emit('end'),
    c => c.stream.emit('close'),
    c => { c._closing = true; },
    c => { c.stream.destroyed = true; },
    c => c.emit('error', Object.assign(new Error('lost'), { fatal: true }))
  ]) {
    const { connection, adapter } = fixture();
    assert.equal(adapter.alive, true);
    close(connection);
    assert.equal(adapter.alive, false);
  }
});

test('un error MySQL no fatal no marca la conexión como cerrada', () => {
  const { connection, adapter } = fixture();
  connection.emit('error', new Error('consulta incorrecta'));
  assert.equal(adapter.alive, true);
});
