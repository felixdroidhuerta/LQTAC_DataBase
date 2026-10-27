const http = require('node:http');
const net = require('node:net');
const { BSON } = require('mongodb');

async function startClickHouseFixture() {
  const queries = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const query = Buffer.concat(chunks).toString(); const url = new URL(request.url, 'http://localhost');
    queries.push({ query, database: url.searchParams.get('database'), headers: request.headers });
    if (url.searchParams.get('database') === 'missing') { response.writeHead(404); response.end('Unknown database'); return; }
    const send = (names, rows) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ meta: names.map(name => ({ name, type: 'String' })), data: rows, rows: rows.length })); };
    if (/SHOW DATABASES/i.test(query)) return send(['name'], [['default'], ['analytics']]);
    if (/FROM system.tables/i.test(query)) return send(['database', 'name', 'engine'], [['default', 'events', 'MergeTree'], ['analytics', 'totals', 'View']]);
    if (/SYNTAX_ERROR/.test(query)) { response.writeHead(400); response.end('Syntax error'); return; }
    if (/^SELECT/i.test(query.trim())) return send(['id', 'payload'], Array.from({ length: /large/i.test(query) ? 1002 : 2 }, (_, id) => [id, { nested: 'valor' }]));
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { profile: { engine: 'clickhouse', name: 'ClickHouse fixture', host: '127.0.0.1', port: server.address().port, username: 'default', database: 'default' }, queries,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

async function startMongoFixture() {
  const commands = []; const sockets = new Set(); let serial = 1;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let pending = Buffer.alloc(0);
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 4 && pending.length >= pending.readInt32LE(0)) {
        const size = pending.readInt32LE(0); if (size < 16) { socket.destroy(); return; }
        const message = pending.subarray(0, size); pending = pending.subarray(size);
        const opcode = message.readInt32LE(12); let document;
        if (opcode === 2004) { const end = message.indexOf(0, 20); document = BSON.deserialize(message.subarray(end + 9)); }
        else if (opcode === 2013) document = BSON.deserialize(message.subarray(21, 21 + message.readInt32LE(21)));
        else { socket.destroy(); return; }
        const kind = Object.keys(document)[0]; const db = document.$db || 'test'; commands.push(document);
        let reply = { ok: 1 };
        const cursor = (batch, collection, id = 0, next = false) => ({ ok: 1, cursor: { id: BSON.Long.fromNumber(id), ns: `${db}.${collection}`, [next ? 'nextBatch' : 'firstBatch']: batch } });
        if (['ismaster', 'isMaster', 'hello'].includes(kind)) reply = { ok: 1, isWritablePrimary: true, ismaster: true, helloOk: true, minWireVersion: 0, maxWireVersion: 25, maxBsonObjectSize: 16777216, maxMessageSizeBytes: 48000000, maxWriteBatchSize: 100000, logicalSessionTimeoutMinutes: 30, connectionId: 1 };
        else if (kind === 'listDatabases') reply = { ok: 1, databases: [{ name: 'test' }, { name: 'other' }] };
        else if (kind === 'listCollections') reply = cursor([{ name: 'clientes', type: 'collection' }, { name: 'vista', type: 'view' }], '$cmd.listCollections');
        else if (['find', 'aggregate'].includes(kind)) reply = cursor(document[kind] === 'large' ? Array.from({ length: 1002 }, (_, n) => ({ n })) : [{ _id: new BSON.ObjectId('000000000000000000000001'), name: 'Ana', score: 4 }, { name: 'Luis', extra: { flag: true } }], document[kind], document[kind] === 'large' ? 77 : 0);
        else if (kind === 'insert') reply = { ok: 1, n: 1 };
        else if (kind === 'badCommand') reply = { ok: 0, code: 59, errmsg: 'No such command' };
        const bson = BSON.serialize(reply); const extra = opcode === 2004 ? 20 : 5;
        const output = Buffer.alloc(16 + extra + bson.length); output.writeInt32LE(output.length, 0); output.writeInt32LE(serial++, 4); output.writeInt32LE(message.readInt32LE(4), 8); output.writeInt32LE(opcode === 2004 ? 1 : 2013, 12);
        if (opcode === 2004) output.writeInt32LE(1, 32);
        bson.copy(output, 16 + extra); socket.write(output);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { profile: { engine: 'mongodb', name: 'Mongo fixture', host: '127.0.0.1', port: server.address().port, username: '', database: 'test' }, commands,
    close: () => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); }) };
}
module.exports = { startClickHouseFixture, startMongoFixture };
