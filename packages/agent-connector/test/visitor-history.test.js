'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const prompts = [], threadStarts = [], spawnedBins = [];
// Emulate only the external app-server protocol, keeping adapter/client/runtime real.
mock.method(childProcess, 'spawn', (bin) => {
  spawnedBins.push(bin);
  const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => {};
  const emit = event => proc.stdout.write(JSON.stringify(event) + '\n');
  const thread = 'fresh-' + (threadStarts.length + 1);
  proc.stdin = new Writable({ write(chunk, encoding, done) {
    for (const line of chunk.toString().trim().split('\n')) {
      const req = JSON.parse(line);
      if (!req.id) continue;
      let result = {};
      if (req.method === 'command/exec') result = { exitCode: 1 };
      if (req.method === 'thread/start') { threadStarts.push(req.params); result = { thread: { id: thread }, activePermissionProfile: { id: 'visitor' }, approvalsReviewer: 'user' }; }
      if (req.method === 'turn/start') {
        prompts.push(req.params.input[0].text);
        result = { turn: { id: 'turn' } };
        setImmediate(() => { emit({ method: 'item/completed', params: { threadId: thread, turnId: 'turn', item: { type: 'agentMessage', text: 'Reply' } } }); emit({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'turn', status: 'completed' } } }); });
      }
      emit({ id: req.id, result });
    }
    done();
  } });
  return proc;
});
const CodexAdapter = require('../src/adapters/codex');
const canonical = 'dm:human:visitor@test,openagents:bot';
const event = (id, source, target, text, extra = {}) => ({ id, source, target, visibility: 'direct', timestamp: '2026-11-26T10:00:00Z', payload: { content: text }, ...extra });

test('fresh controlled visitor turns preserve bounded current-DM history without resuming owner threads', async t => {
  prompts.length = 0; threadStarts.length = 0;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visitor-history-')));
  const queries = [], posted = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let raw = ''; for await (const chunk of req) raw += chunk;
    let data = {};
    if (url.pathname.endsWith('/context')) data = { required: true, owner_email: 'owner@test', visitor_email: 'visitor@test', paused: false };
    if (url.pathname === '/v1/events' && req.method === 'GET') {
      queries.push(url.searchParams);
      data = { events: url.searchParams.get('conversation') ? [
        event('future', 'human:visitor@test', 'openagents:bot', 'FUTURE_SECRET', { timestamp: '2026-11-26T12:00:00Z' }),
        event('trigger', 'human:visitor@test', 'openagents:bot', 'DUPLICATE_TRIGGER'),
        event('noise', 'openagents:bot', 'human:visitor@test', 'STATUS_NOISE', { payload: { content: 'STATUS_NOISE', message_type: 'status' } }),
        event('other', 'human:other@test', 'openagents:bot', 'OTHER_VISITOR_SECRET'),
        event('owner', 'human:owner@test', 'human:visitor@test', 'Owner clarified: use archive folder', { metadata: { dm_agent: 'openagents:bot' } }),
        event('reply', 'openagents:bot', 'human:visitor@test', 'Earlier answer: rename snake-game'),
        event('question', 'human:visitor@test', 'openagents:bot', 'Earlier question about snake-game ' + 'x'.repeat(20000)),
      ] : [] };
    }
    if (url.pathname === '/v1/events' && raw) posted.push(JSON.parse(raw));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const adapter = new CodexAdapter({ endpoint: `http://127.0.0.1:${server.address().port}`, workspaceId: 'history-test', token: 'HOST_CREDENTIAL_SENTINEL', agentName: 'bot' });
  adapter._codexBin = path.join(dir, 'npm-shim'); adapter._useCliMode = true; adapter._customProvider = null; adapter.agentEnv = { CODEX_APPROVAL_BINARY: process.execPath }; adapter.workingDir = dir;
  adapter._channelThreads['dm:human:visitor@test'] = 'unrestricted-owner-thread';
  t.after(async () => { clearTimeout(adapter._presenceHeartbeatTimer); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 2; i++) {
    const msg = { sessionId: 'dm:human:visitor@test', messageId: 'trigger', senderType: 'human', senderName: 'visitor@test', content: 'Yes, use that name', createdAt: '2026-11-26T11:00:00Z' };
    await adapter._dispatchMessage(msg);
    for (let n = 0; adapter._channelBusy.has(msg.sessionId) && n < 1000; n++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(adapter._channelBusy.has(msg.sessionId), false);
  }
  assert.equal(prompts.length, 2);
  assert.ok(spawnedBins.every(bin => bin === fs.realpathSync(process.execPath)));
  for (const prompt of prompts) {
    assert.match(prompt, /Earlier answer: rename snake-game/);
    assert.match(prompt, /Owner clarified: use archive folder/);
    assert.match(prompt, /Earlier question about snake-game/);
    assert.match(prompt, /Yes, use that name/);
    for (const absent of ['OTHER_VISITOR_SECRET', 'FUTURE_SECRET', 'DUPLICATE_TRIGGER', 'STATUS_NOISE', 'HOST_CREDENTIAL_SENTINEL', 'unrestricted-owner-thread']) assert.ok(!prompt.includes(absent), absent);
    assert.ok(prompt.length < 18000);
  }
  assert.equal(queries.filter(q => q.get('conversation') === canonical.slice(3) && q.get('before') === 'trigger' && q.get('limit') === '30').length, 2);
  assert.equal(threadStarts.length, 2); assert.ok(threadStarts.every(p => p.ephemeral));
  assert.equal(adapter._channelThreads['dm:human:visitor@test'], 'unrestricted-owner-thread');
  assert.ok(posted.filter(e => e.payload?.content === 'Reply').every(e => e.target === 'human:visitor@test'));
});
