'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OperationExecutor } = require('../src/operation-approvals/executor');
function fixture(t, status = 'approved') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-operation-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'work'); fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'snake-game')); fs.writeFileSync(path.join(root, 'snake-game', 'game.js'), 'original');
  let record; let claims = 0;
  const api = {
    create: async payload => (record = { ...payload, id: 'request-one', operation_digest: 'digest', status, paused: false }),
    get: async () => record,
    claim: async () => { claims++; return { execution_token: 'once' }; },
    result: async (_id, result) => { record = { ...record, ...result }; return record; },
  };
  const make = () => new OperationExecutor({ root, journalDir: path.join(dir, 'journal'), api, pollMs: 1 });
  return { root, make, api, record: () => record, claims: () => claims };
}
test('approved directory move preserves files and cannot execute again after restart', async t => {
  const f = fixture(t);
  const result = await f.make().requestMove({ source: 'snake-game', destination: 'test-game', sessionId: 'dm:visitor:agent', requestKey: 'turn:call' });
  assert.equal(result.status, 'succeeded');
  assert.equal(fs.readFileSync(path.join(f.root, 'test-game', 'game.js'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(f.root, 'snake-game')), false);
  fs.mkdirSync(path.join(f.root, 'snake-game')); fs.writeFileSync(path.join(f.root, 'snake-game', 'game.js'), 'replacement');
  await assert.rejects(f.make().requestMove({ source: 'snake-game', destination: 'another-game', sessionId: 'dm:visitor:agent', requestKey: 'turn:call' }));
  assert.equal(fs.existsSync(path.join(f.root, 'another-game')), false);
  assert.equal(f.claims(), 1);
});
test('a destination created while approval is pending is never overwritten and invalidates the request', async t => {
  const f = fixture(t, 'pending');
  f.api.get = async () => {
    fs.writeFileSync(path.join(f.root, 'test-game'), 'keep me');
    return { ...f.record(), status: 'approved' };
  };
  const result = await f.make().requestMove({ source: 'snake-game', destination: 'test-game', sessionId: 'dm:v:a', requestKey: 'changed' });
  assert.equal(result.status, 'invalidated');
  assert.equal(fs.readFileSync(path.join(f.root, 'test-game'), 'utf8'), 'keep me');
  assert.equal(fs.existsSync(path.join(f.root, 'snake-game', 'game.js')), true);
});
for (const status of ['rejected', 'expired', 'withdrawn']) {
  test(`${status} approval leaves the filesystem unchanged`, async t => {
    const f = fixture(t, status);
    const result = await f.make().requestMove({ source: 'snake-game', destination: 'test-game', sessionId: 'dm:v:a', requestKey: status });
    assert.equal(result.status, status);
    assert.equal(fs.existsSync(path.join(f.root, 'snake-game', 'game.js')), true);
    assert.equal(fs.existsSync(path.join(f.root, 'test-game')), false);
    assert.equal(f.claims(), 0);
  });
}
test('approved move waits through takeover and then resumes automatically', async t => {
  const f = fixture(t, 'pending');
  let reads = 0;
  f.api.get = async () => {
    assert.equal(fs.existsSync(path.join(f.root, 'test-game')), false);
    assert.equal(f.claims(), 0);
    return { ...f.record(), status: 'approved', paused: ++reads < 3 };
  };
  const result = await f.make().requestMove({ source: 'snake-game', destination: 'test-game', sessionId: 'dm:v:a', requestKey: 'takeover' });
  assert.equal(reads, 3); assert.equal(result.status, 'succeeded');
});
test('lost claim response never executes or retries', async t => {
  const f = fixture(t);
  f.api.claim = async () => { throw new Error('connection lost after claim'); };
  await assert.rejects(f.make().requestMove({ source: 'snake-game', destination: 'test-game', sessionId: 'dm:v:a', requestKey: 'lost' }));
  await assert.rejects(f.make().requestMove({ source: 'snake-game', destination: 'test-game', sessionId: 'dm:v:a', requestKey: 'lost' }));
  assert.equal(fs.existsSync(path.join(f.root, 'test-game')), false);
});
for (const source of ['../escape', '/tmp/escape', '.', 'snake-game/../snake-game', 'link']) {
  test(`unsafe source ${source} cannot request an approval`, async t => {
    const f = fixture(t);
    fs.symlinkSync(path.join(f.root, 'snake-game'), path.join(f.root, 'link'));
    await assert.rejects(f.make().requestMove({ source, destination: 'test-game', sessionId: 'dm:v:a', requestKey: source }));
    assert.equal(f.record(), undefined);
    assert.equal(fs.existsSync(path.join(f.root, 'test-game')), false);
  });
}
test('a file changed before approval requires fresh authorization', async t => {
  const f = fixture(t, 'pending');
  f.api.get = async () => {
    fs.writeFileSync(path.join(f.root, 'snake-game', 'game.js'), 'modified');
    return { ...f.record(), status: 'approved' };
  };
  const result = await f.make().requestMove({ source: 'snake-game', destination: 'test-game', sessionId: 'dm:v:a', requestKey: 'modified' });
  assert.equal(result.status, 'invalidated');
  assert.equal(fs.existsSync(path.join(f.root, 'test-game')), false);
});
test('completion reporting loss preserves actual success and never replays the move', async t => {
  const f = fixture(t);
  f.api.result = async () => { throw new Error('offline'); };
  const result = await f.make().requestMove({ source: 'snake-game', destination: 'test-game', sessionId: 'dm:v:a', requestKey: 'completion' });
  assert.equal(result.status, 'succeeded'); assert.equal(result.completion_unconfirmed, true);
  await assert.rejects(f.make().requestMove({ source: 'test-game', destination: 'other', sessionId: 'dm:v:a', requestKey: 'completion' }));
  assert.equal(fs.readFileSync(path.join(f.root, 'test-game', 'game.js'), 'utf8'), 'original');
});
test('host execution refuses its own journal tree even when configured inside the work root', async t => {
  const f = fixture(t);
  const executor = new OperationExecutor({ root: f.root, journalDir: path.join(f.root, 'journal'), api: f.api });
  await assert.rejects(executor.requestMove({ source: 'snake-game', destination: 'test-game', sessionId: 'dm:v:a', requestKey: 'unsafe-journal' }), /journal|root/i);
  assert.equal(fs.existsSync(path.join(f.root, 'test-game')), false);
});
test('runtime configuration cannot be renamed into or out of the work root', async t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.root, '.codex'));
  await assert.rejects(f.make().requestMove({ source: '.codex', destination: 'config-backup', sessionId: 'dm:v:a', requestKey: 'config' }));
  await assert.rejects(f.make().requestMove({ source: 'snake-game', destination: '.git', sessionId: 'dm:v:a', requestKey: 'metadata' }));
  assert.equal(f.record(), undefined);
});
