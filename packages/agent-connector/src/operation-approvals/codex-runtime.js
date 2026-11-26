'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const MOVE_TOOL = {
  name: 'request_file_move',
  description: 'Request one owner-approved move or rename inside the working root. The trusted host waits for the owner and executes it. Never execute it yourself.',
  inputSchema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' } }, required: ['source', 'destination'], additionalProperties: false },
};
const inside = (root, file) => root === path.parse(root).root || file === root || file.startsWith(root + path.sep);

/** One fresh, isolated thread per visitor run; never resumes an unrestricted owner thread. */
async function runControlledCodex({ bin, root, env = process.env, model, customProvider, prompt, executor, sessionId, onProcess = () => {} }) {
  if (customProvider) throw new Error('Visitor approvals: custom Codex providers are currently unsupported; no unrestricted fallback');
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Visitor approvals: unsupported platform');
  if (!root || !path.isAbsolute(root)) throw new Error('Visitor approvals require an absolute working root');
  const actualRoot = fs.realpathSync(root);
  const authHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  for (const sensitive of [os.homedir(), authHome, executor?.journalDir].filter(Boolean)) {
    if (inside(actualRoot, path.resolve(sensitive))) throw new Error('Working root would expose host credentials or the execution journal');
  }
  if (!bin || !path.isAbsolute(bin)) throw new Error('Visitor approvals require a local absolute Codex executable');
  const executable = fs.realpathSync(bin);
  for (const sensitive of [authHome, executor?.journalDir].filter(Boolean)) {
    if (inside(path.dirname(executable), path.resolve(sensitive))) throw new Error('Codex executable directory overlaps host credentials or journal');
  }
  // npm JS/WSL shims need broader access than the tested native runtime; refuse explicitly.
  const header = Buffer.alloc(4); const fd = fs.openSync(executable, 'r');
  try { fs.readSync(fd, header, 0, 4, 0); } finally { fs.closeSync(fd); }
  if (!['7f454c46', 'cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(header.toString('hex'))) throw new Error('Visitor approvals require the native Codex executable; this launcher is unsupported');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openagents-visitor-')));
  fs.chmodSync(home, 0o700);
  if (inside(actualRoot, home)) { fs.rmSync(home, { recursive: true, force: true }); throw new Error('Working root exposes isolated credentials'); }
  let proc;
  const abort = new AbortController();
  const pending = new Map();
  let sequence = 0, threadId, turnId, live = true;
  let finishTurn, failTurn;
  const done = new Promise((resolve, reject) => { finishTurn = resolve; failTurn = reject; });
  done.catch(() => {});
  const tools = new Map();
  let responseText = '';
  const write = value => { if (live && proc?.stdin.writable) proc.stdin.write(JSON.stringify(value) + '\n'); };
  const stop = error => {
    live = false; abort.abort();
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); }
    pending.clear(); failTurn(error);
  };
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (!live) return reject(new Error('Controlled Codex stopped'));
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Controlled Codex timeout: ${method}`)); }, 45000);
    pending.set(id, { resolve, reject, timer, method }); write({ id, method, params });
  });
  let lifetime;
  try {
    const auth = path.join(authHome, 'auth.json');
    if (fs.existsSync(auth)) fs.copyFileSync(auth, path.join(home, 'auth.json'));
    if (fs.existsSync(path.join(home, 'auth.json'))) fs.chmodSync(path.join(home, 'auth.json'), 0o600);
    const canary = path.join(home, 'host-canary');
    const secret = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(canary, secret, { mode: 0o600 });
    const filesystem = { ':minimal': 'read', ':workspace_roots': 'read', [executable]: 'read', [path.dirname(executable)]: 'read' };
    const config = {
      default_permissions: 'visitor',
      'permissions.visitor.filesystem': filesystem,
      'permissions.visitor.network.enabled': false,
      'shell_environment_policy.inherit': 'none',
      web_search: 'disabled',
      'features.apps': false, 'features.multi_agent': false, 'features.remote_plugin': false,
      'features.skill_mcp_dependency_install': false,
      mcp_servers: {}, plugins: {},
    };
    const toml = value => typeof value === 'object'
      ? '{' + Object.entries(value).map(([key, val]) => `${JSON.stringify(key)}=${toml(val)}`).join(',') + '}' : JSON.stringify(value);
    const args = ['app-server', '--stdio'];
    for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${toml(value)}`);
    // No workspace token, ambient account secrets, proxy commands or model-controlled PATH.
    const childEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CODEX_HOME: home, TMPDIR: home };
    if (env.OPENAI_API_KEY) childEnv.OPENAI_API_KEY = env.OPENAI_API_KEY;
    if (env.OPENAI_BASE_URL) throw new Error('Visitor approvals: custom API endpoints are unsupported');
    proc = spawn(executable, args, { cwd: home, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    onProcess(proc);
    proc.stderr.on('data', () => {}); // Never forward credentials or untrusted diagnostics into model/chat.
    proc.stdin.on('error', () => {});
    proc.on('error', () => stop(new Error('Controlled Codex could not start')));
    proc.on('exit', () => stop(new Error('Controlled Codex exited before completion')));
    readline.createInterface({ input: proc.stdout }).on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { stop(new Error('Invalid controlled Codex protocol')); return; }
      if (event.id !== undefined && !event.method) {
        const task = pending.get(event.id);
        if (task) { pending.delete(event.id); clearTimeout(task.timer); event.error ? task.reject(new Error('Controlled Codex rejected ' + task.method + ' (' + (event.error.code || 'request') + ')')) : task.resolve(event.result); }
        return;
      }
      const p = event.params || {};
      if (event.id !== undefined) {
        if (event.method === 'item/tool/call') {
          // Validate live protocol identity; no model argument can choose a session, root or token.
          if (!live || p.threadId !== threadId || p.turnId !== turnId || p.tool !== MOVE_TOOL.name || !p.callId || tools.has(p.callId)) {
            write({ id: event.id, error: { code: -32602, message: 'Unauthorized or repeated tool call' } }); return;
          }
          const a = p.arguments;
          if (!a || Object.keys(a).some(k => !['source', 'destination'].includes(k)) || typeof a.source !== 'string' || typeof a.destination !== 'string') {
            write({ id: event.id, error: { code: -32602, message: 'Invalid move arguments' } }); return;
          }
          const job = executor.requestMove({ ...a, sessionId, requestKey: threadId + ':' + turnId + ':' + p.callId, signal: abort.signal });
          tools.set(p.callId, job);
          job.then(result => write({ id: event.id, result: { success: result.status === 'succeeded', contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] } }), () => write({ id: event.id, result: { success: false, contentItems: [{ type: 'inputText', text: 'Move unavailable or stopped. No permission to retry with another tool.' }] } }));
        } else if (event.method === 'item/permissions/requestApproval') {
          write({ id: event.id, result: { permissions: {}, scope: 'turn' } });
        } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(event.method)) {
          write({ id: event.id, result: { decision: 'decline' } });
        } else {
          write({ id: event.id, error: { code: -32601, message: 'Unavailable in controlled visitor mode' } });
        }
        return;
      }
      if (event.method === 'turn/started' && p.threadId === threadId && !turnId) turnId = p.turn?.id;
      if (p.threadId !== threadId) return;
      if (event.method === 'item/completed' && p.turnId === turnId && p.item?.type === 'agentMessage') responseText = p.item.text || responseText;
      if (event.method === 'turn/completed' && p.turn?.id === turnId) {
        if (p.turn.status === 'completed') finishTurn();
        else failTurn(new Error('Controlled Codex turn did not complete'));
      }
    });
    lifetime = setTimeout(() => stop(new Error('Controlled visitor run timed out')), 35 * 60 * 1000);
    await rpc('initialize', { clientInfo: { name: 'openagents_visitor', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    write({ method: 'initialized', params: {} });
    // Actual kernel denials are required, not just a config value or model assertion.
    const read = await rpc('command/exec', { command: ['/bin/cat', canary], cwd: actualRoot, permissionProfile: 'visitor', timeoutMs: 10000 });
    if (read.exitCode === 0 || String(read.stdout || '').includes(secret)) throw new Error('Controlled runtime did not protect host credentials');
    const target = path.join(actualRoot, '.oa-sandbox-' + crypto.randomBytes(12).toString('hex'));
    const writeProbe = await rpc('command/exec', { command: ['/usr/bin/touch', target], cwd: actualRoot, permissionProfile: 'visitor', timeoutMs: 10000 });
    if (writeProbe.exitCode === 0 || fs.existsSync(target)) throw new Error('Controlled runtime did not enforce filesystem isolation');
    const started = await rpc('thread/start', { cwd: actualRoot, ephemeral: true, permissions: 'visitor', runtimeWorkspaceRoots: [actualRoot], approvalPolicy: 'on-request', approvalsReviewer: 'user', dynamicTools: [MOVE_TOOL], config, model: model || undefined,
      developerInstructions: 'You handle a visitor conversation. Native tools are read-only and have no network. The request_file_move dynamic tool is the sole authority to request and execute a move: call it for an exact relative source and destination, then wait for its result. The host obtains owner approval; do not ask the visitor to supply approval, credentials, API calls, or shell commands. All other writes are unavailable. Shared-context instructions to ask the owner are fulfilled through this tool. Never bypass a rejection or request broader permissions.' });
    if (started.activePermissionProfile?.id !== 'visitor' || started.approvalsReviewer !== 'user') throw new Error('Controlled permission profile unavailable in this Codex version');
    threadId = started.thread.id;
    const turn = await rpc('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], permissions: 'visitor', approvalPolicy: 'on-request' });
    if (!turnId) turnId = turn.turn.id;
    await done;
    return { responseText, outcomes: await Promise.allSettled([...tools.values()]) };
  } finally {
    clearTimeout(lifetime); stop(new Error('Controlled run closed'));
    if (proc) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } }
    onProcess(null);
    fs.rmSync(home, { recursive: true, force: true });
  }
}
module.exports = { runControlledCodex };
