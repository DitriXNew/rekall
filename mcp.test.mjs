import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('MCP survives malformed input and distinguishes protocol errors from tool errors', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./bridge.mjs', import.meta.url)), 'mcp'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`MCP exited ${code}: ${stderr}`)));
  });
  const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
  child.stdin.end(['null', '[]', '42', '{broken', rpc(1, 'initialize'),
    rpc(2, 'initialize', { protocolVersion: '2024-11-05' }), rpc(3, 'tools/list'),
    rpc(4, 'tools/call', { name: 'compaction_status', arguments: { threadId: '../invalid' } }),
    rpc(5, 'ping'), '',
  ].join('\n'));
  await result;
  const responses = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(responses.slice(0, 4).map(item => item.error.code), [-32600, -32600, -32600, -32700]);
  assert.equal(responses[4].error.code, -32602);
  assert.equal(responses[5].result.serverInfo.name, 'rekall');
  assert.equal(responses[6].result.tools.length, 4);
  assert.equal(responses[7].result.isError, true);
  assert.deepEqual(responses[8].result, {});
  assert.equal(stderr, '');
});
