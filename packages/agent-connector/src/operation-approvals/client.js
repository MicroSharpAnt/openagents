'use strict';
const http = require('node:http');
const https = require('node:https');

/** Credentials and claim tokens stay in the connector host, outside all model inputs. */
class ApprovalClient {
  constructor({ endpoint, network, token, agentName }) {
    this.endpoint = endpoint.replace(/\/$/, '') + '/v1/operation-approvals';
    this.network = network;
    this.headers = { 'Content-Type': 'application/json', 'X-Workspace-Token': token, 'X-Agent-Name': agentName };
  }
  async request(method, suffix, body) {
    const url = new URL(this.endpoint + suffix);
    if (method === 'GET') url.searchParams.set('network', this.network);
    const payload = method === 'GET' ? null : JSON.stringify({ ...body, network: this.network });
    return new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).request(url, { method, headers: this.headers, signal: AbortSignal.timeout(15000) }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) req.destroy(new Error('Approval response too large')); });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Approval response incomplete')));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(Object.assign(new Error(`Approval service HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
          try {
            const result = JSON.parse(text);
            if (!result.data || (result.code !== undefined && result.code !== 200 && result.code !== 0)) throw new Error('Invalid approval response');
            resolve(result.data);
          } catch { reject(new Error('Invalid approval response')); }
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  context(sessionId) { return this.request('GET', '/context?session_id=' + encodeURIComponent(sessionId)); }
  create(payload) { return this.request('POST', '', payload); }
  get(id) { return this.request('GET', '/' + encodeURIComponent(id)); }
  claim(id, digest) { return this.request('POST', '/' + encodeURIComponent(id) + '/claim', { operation_digest: digest }); }
  result(id, outcome) { return this.request('POST', '/' + encodeURIComponent(id) + '/result', outcome); }
}
module.exports = { ApprovalClient };
