'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runControlledCodex } = require('../src/operation-approvals/codex-runtime');
test('unsupported provider fails closed before any runtime or move can start', async () => {
  await assert.rejects(runControlledCodex({ customProvider: { baseUrl: 'https://example.test' } }), /unsupported/i);
});
test('a work root containing credentials is refused', async () => {
  await assert.rejects(runControlledCodex({ root: os.homedir(), bin: process.execPath }), /credential|root/i);
});
test('an unavailable canonical DM context prevents the unrestricted execution route', async t => {
  const http = require('node:http');
  const CodexAdapter = require('../src/adapters/codex');
  const server = http.createServer((_req, res) => { res.writeHead(503); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  let ran = false; const errors = [];
  const adapter = Object.assign(Object.create(CodexAdapter.prototype), {
    endpoint: `http://127.0.0.1:${server.address().port}`, workspaceId: 'network', token: 'test-credential', agentName: 'agent',
    _useCliMode: true, _log() {}, _autoTitleChannel: async () => {}, sendStatus: async () => {},
    _handleViaSubprocess: async () => { ran = true; }, sendError: async (_channel, text) => errors.push(text),
  });
  await adapter._handleMessage({ content: 'move source to target', senderType: 'human', sessionId: 'dm:visitor:agent' });
  assert.equal(ran, false);
  assert.match(errors.join(' '), /context|approval/i);
});
for (const required of [false, true]) {
  test(required ? 'visitor DM cannot fall back to unrestricted execution without a controlled runtime' : 'owner own DM retains its normal execution route', async t => {
    const http = require('node:http');
    const CodexAdapter = require('../src/adapters/codex');
    const server = http.createServer((req, res) => {
      assert.equal(req.headers['x-workspace-token'], 'test-credential');
      assert.equal(req.headers['x-agent-name'], 'agent');
      assert.match(req.url, /context\?session_id=dm%3Avisitor%3Aagent&network=network/);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 0, data: { required, paused: false, owner_email: 'owner@example.test', visitor_email: required ? 'visitor@example.test' : 'owner@example.test' } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
    let ran = false; const errors = [];
    const adapter = Object.assign(Object.create(CodexAdapter.prototype), {
      endpoint: `http://127.0.0.1:${server.address().port}`, workspaceId: 'network', token: 'test-credential', agentName: 'agent',
      _useCliMode: true, _codexBin: null, _log() {}, _autoTitleChannel: async () => {}, sendStatus: async () => {},
      _handleViaSubprocess: async () => { ran = true; }, sendError: async (_channel, text) => errors.push(text),
    });
    await adapter._handleMessage({ content: 'move source to target', senderType: 'human', sessionId: 'dm:visitor:agent' });
    assert.equal(ran, !required);
    assert.equal(errors.length, required ? 1 : 0);
  });
}
