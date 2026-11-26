'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const BaseAdapter = require('../src/adapters/base');

// This adapter exposes the subclass dispatch boundary without launching a CLI.
class RecordingAdapter extends BaseAdapter {
  async _handleMessage(msg) { this.runs.push(msg.sessionId); }
  async sendError(channel, text) { this.errors.push(text); }
}
async function fixture(t, context) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/operation-approvals/context')) {
      const session = new URL(req.url, 'http://localhost').searchParams.get('session_id');
      const value = context(session);
      res.writeHead(value ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: value ? 200 : 503, data: value }));
    } else { res.end(JSON.stringify({ code: 200, data: {} })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = new RecordingAdapter({ endpoint: `http://127.0.0.1:${server.address().port}`, workspaceId: 'ws', token: 'token', agentName: 'bot' });
  adapter.runs = []; adapter.errors = [];
  t.after(() => { clearTimeout(adapter._presenceHeartbeatTimer); });
  return adapter;
}
async function dispatch(adapter, sessionId) {
  await adapter._dispatchMessage({ sessionId, senderType: 'human', content: 'move file', messageId: 'one' });
  for (let i = 0; adapter._channelBusy.has(sessionId) && i < 500; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(adapter._channelBusy.has(sessionId), false);
}
test('unsupported runtime refuses visitor DM before adapter execution using authoritative context', async t => {
  const adapter = await fixture(t, () => ({ required: true, owner_email: 'owner@test', visitor_email: 'visitor@test', paused: false }));
  await dispatch(adapter, 'dm:human:visitor@test,openagents:bot');
  assert.deepEqual(adapter.runs, []);
  assert.match(adapter.errors.join(' '), /unsupported|unavailable/i);
});
test('owners, channels and agent-agent DMs retain normal execution', async t => {
  const adapter = await fixture(t, () => ({ required: false, owner_email: 'owner@test', visitor_email: 'owner@test', paused: false }));
  const sessions = ['dm:human:owner@test,openagents:bot', 'general', 'dm:openagents:bot,openagents:other'];
  for (const session of sessions) await dispatch(adapter, session);
  assert.deepEqual(adapter.runs, sessions);
});
for (const context of [null, {}, { required: true, paused: true, owner_email: 'owner@test', visitor_email: 'visitor@test' }]) {
  test(`unavailable, invalid or paused context prevents execution: ${JSON.stringify(context)}`, async t => {
    const adapter = await fixture(t, () => context);
    await dispatch(adapter, 'dm:human:visitor@test,openagents:bot');
    assert.deepEqual(adapter.runs, []);
  });
}
