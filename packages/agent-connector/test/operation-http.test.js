'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ApprovalClient } = require('../src/operation-approvals/client');
const { OperationExecutor } = require('../src/operation-approvals/executor');

async function fixture(t, handler) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-wire-')));
  const root = path.join(dir, 'work'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'before'), 'keep');
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const reply = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: status, data })); };
    handler(req, body, reply);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const api = new ApprovalClient({ endpoint: `http://127.0.0.1:${server.address().port}`, network: 'ws', token: 'secret', agentName: 'bot' });
  const executor = new OperationExecutor({ root, journalDir: path.join(dir, 'journal'), api, pollMs: 1 });
  return { root, run: () => executor.requestMove({ source: 'before', destination: 'after', sessionId: 'dm:v:a', requestKey: 'call' }) };
}
const approved = { id: 'one', operation_digest: 'digest', status: 'approved', paused: false };
test('completion crosses HTTP as backend string result and confirms the real move', async t => {
  let completion;
  const f = await fixture(t, (req, body, reply) => {
    if (req.url.endsWith('/claim')) return reply({ execution_token: 'once' });
    if (req.url.endsWith('/result')) { completion = body; return reply({}, typeof body.result === 'string' ? 200 : 422); }
    reply(approved);
  });
  const outcome = await f.run();
  assert.equal(outcome.completion_unconfirmed, undefined);
  assert.equal(typeof completion.result, 'string');
  assert.equal(completion.status, 'succeeded');
  assert.equal(fs.readFileSync(path.join(f.root, 'after'), 'utf8'), 'keep');
});
test('takeover racing claim waits for resume after explicit HTTP 409', async t => {
  let claims = 0, reads = 0;
  const f = await fixture(t, (req, body, reply) => {
    if (req.url.endsWith('/claim')) return ++claims === 1 ? reply({}, 409) : reply({ execution_token: 'once' });
    if (req.method === 'GET') return reply({ ...approved, paused: ++reads < 3 });
    reply(approved);
  });
  assert.equal((await f.run()).status, 'succeeded');
  assert.equal(claims, 2); assert.equal(reads, 3);
});
for (const consumed of [false, true]) {
  test(`claim ${consumed ? '409 with consumed grant' : 'lost response'} never retries or executes`, async t => {
    let claims = 0;
    const f = await fixture(t, (req, body, reply) => {
      if (req.url.endsWith('/claim')) { claims++; return consumed ? reply({}, 409) : req.socket.destroy(); }
      if (req.method === 'GET') return reply({ ...approved, status: 'executing' });
      reply(approved);
    });
    await assert.rejects(f.run());
    assert.equal(claims, 1);
    assert.equal(fs.existsSync(path.join(f.root, 'after')), false);
  });
}
test('resume between denied claim and reconciliation still executes exactly once', async t => {
  let claims = 0, reads = 0;
  const f = await fixture(t, (req, body, reply) => {
    if (req.url.endsWith('/claim')) return ++claims === 1 ? reply({}, 409) : reply({ execution_token: 'once' });
    if (req.method === 'GET') { reads++; return reply(approved); }
    reply(approved);
  });
  assert.equal((await f.run()).status, 'succeeded');
  assert.equal(claims, 2);
  assert.equal(reads, 1);
  assert.equal(fs.readFileSync(path.join(f.root, 'after'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(f.root, 'before')), false);
});
