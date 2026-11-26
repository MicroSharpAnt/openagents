'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');

function nativeMove(payload) {
  return new Promise((resolve, reject) => {
    const proc = execFile('python3', ['-I', path.join(__dirname, 'move-helper.py')], { timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      let result;
      try { result = JSON.parse(stdout); } catch { return reject(new Error('Trusted native move helper unavailable')); }
      if (err || result.error) reject(new Error(result.error || 'Native move failed'));
      else resolve(result);
    });
    proc.stdin.end(JSON.stringify(payload));
  });
}
function durableWrite(file, value, exclusive = false) {
  const fd = fs.openSync(file, exclusive ? 'wx' : 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

/** Public execution boundary. API is the authenticated host client, never model-controlled. */
class OperationExecutor {
  constructor({ root, journalDir, api, pollMs = 1500 }) {
    this.root = root;
    this.journalDir = journalDir;
    this.api = api;
    this.pollMs = pollMs;
  }
  async requestMove({ source, destination, sessionId, requestKey, signal }) {
    if (typeof requestKey !== 'string' || !requestKey || !sessionId) throw new Error('Missing operation identity');
    const checkAbort = () => { if (signal?.aborted) throw new Error('Operation stopped'); };
    checkAbort();
    const actualRoot = fs.realpathSync(this.root);
    for (const secret of [os.homedir(), path.join(os.homedir(), '.codex'), path.join(os.homedir(), '.openagents'), this.journalDir]) {
      const absolute = path.resolve(secret);
      if (absolute === actualRoot || absolute.startsWith(actualRoot + path.sep)) throw new Error('Work root exposes host credentials or execution journal');
    }
    fs.mkdirSync(this.journalDir, { recursive: true, mode: 0o700 });
    const key = crypto.createHash('sha256').update(sessionId + '\0' + requestKey).digest('hex');
    const journal = path.join(this.journalDir, key + '.json');
    // Reserving before any HTTP request also makes concurrent same-call attempts fail closed.
    durableWrite(journal, { phase: 'preflight', requestKey, sessionId }, true);
    const inspected = await nativeMove({ root: this.root, source, destination });
    const operation = Object.freeze({ kind: 'move', root: this.root, source, destination, expected_state: inspected.expected_state });
    let record = await this.api.create({ session_id: sessionId, request_key: requestKey, operation });
    if (!record?.id || !record.operation_digest) throw new Error('Invalid approval response');
    durableWrite(journal, { phase: 'waiting', id: record.id, operation });
    const deadline = Date.now() + 31 * 60 * 1000;
    while (record.status === 'pending' || (record.status === 'approved' && record.paused)) {
      checkAbort();
      if (Date.now() > deadline) throw new Error('Approval wait expired');
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
      record = await this.api.get(record.id);
    }
    checkAbort();
    if (record.status !== 'approved') return { status: record.status, result: { reason: 'Operation not approved; no filesystem changes' } };
    // Save intent BEFORE claim. A lost response or crash is never retried.
    durableWrite(journal, { phase: 'claiming', id: record.id, operation });
    const claim = await this.api.claim(record.id, record.operation_digest);
    if (!claim?.execution_token) throw new Error('Execution claim not granted');
    durableWrite(journal, { phase: 'claimed', id: record.id, operation });
    let outcome;
    try {
      checkAbort();
      outcome = await nativeMove({ ...operation, execute: true });
    } catch (error) {
      outcome = { status: 'failed', result: { reason: error.message } };
    }
    durableWrite(journal, { phase: 'completed', id: record.id, operation, outcome });
    try { await this.api.result(record.id, { ...outcome, execution_token: claim.execution_token }); }
    catch { return { ...outcome, completion_unconfirmed: true }; }
    return outcome;
  }
}
module.exports = { OperationExecutor };
