import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { applyPatches, CodexIpc, resolveIpcEndpoint } from './ipc.mjs';
import { continuationText } from './handoff.mjs';

function macSocketFixture({ env = {}, directory = {}, socket = {}, getuid = () => 501 } = {}) {
  const seen = [];
  const options = { platform: 'darwin', env, homedir: () => '/Users/synthetic', getuid,
    lstatSync: file => {
      seen.push(file);
      return file.endsWith('/ipc.sock')
        ? { isSocket: () => true, uid: 501, mode: 0o600, ...socket }
        : { isDirectory: () => true, uid: 501, mode: 0o700, ...directory };
    } };
  return { options, seen };
}

test('Windows IPC keeps its named pipe without consulting Unix files or identity', () => {
  const unexpected = () => { throw new Error('Unexpected Unix lookup'); };
  assert.equal(resolveIpcEndpoint({ platform: 'win32', homedir: unexpected,
    getuid: unexpected, lstatSync: unexpected }), '\\\\.\\pipe\\codex-ipc');
});

test('macOS IPC resolves the private default or explicit Codex home', () => {
  for (const [env, expected] of [[{}, '/Users/synthetic/.codex/ipc/ipc.sock'],
    [{ CODEX_HOME: '/private/custom codex' }, '/private/custom codex/ipc/ipc.sock']]) {
    const { options, seen } = macSocketFixture({ env });
    assert.equal(resolveIpcEndpoint(options), expected);
    assert.deepEqual(seen, [expected.slice(0, -9), expected]);
  }
  assert.throws(() => resolveIpcEndpoint(macSocketFixture({ env: { CODEX_HOME: 'relative' } }).options), /absolute/);
});

test('macOS IPC rejects foreign, exposed, or symlinked directories and sockets', () => {
  for (const directory of [{ uid: 502 }, { mode: 0o755 }, { mode: 0o770 }, { isDirectory: () => false }]) {
    const { options, seen } = macSocketFixture({ directory });
    assert.throws(() => resolveIpcEndpoint(options), /directory must be private/);
    assert.equal(seen.length, 1);
  }
  for (const socket of [{ uid: 502 }, { mode: 0o666 }, { mode: 0o640 }, { isSocket: () => false }]) {
    assert.throws(() => resolveIpcEndpoint(macSocketFixture({ socket }).options), /socket must be private/);
  }
  assert.throws(() => resolveIpcEndpoint(macSocketFixture({ getuid: () => undefined }).options), /verify.*user/);
});

test('missing macOS socket fails without falling back to another endpoint', () => {
  const { options } = macSocketFixture();
  options.lstatSync = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  assert.throws(() => resolveIpcEndpoint(options), { code: 'ENOENT' });
  assert.throws(() => resolveIpcEndpoint({ platform: 'linux' }), /unsupported on linux/);
});

test('macOS endpoint checks work with real isolated Unix sockets and symlinks',
  { skip: process.platform === 'win32' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rekall-ipc-test-'));
    const directory = path.join(root, 'ipc');
    const endpoint = path.join(directory, 'ipc.sock');
    const server = net.createServer();
    t.after(async () => {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.mkdirSync(directory, { mode: 0o700 });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });
    fs.chmodSync(endpoint, 0o600);
    const options = { platform: 'darwin', env: { CODEX_HOME: root } };
    assert.equal(resolveIpcEndpoint(options), endpoint);
    fs.chmodSync(endpoint, 0o666);
    assert.throws(() => resolveIpcEndpoint(options), /socket must be private/);
    fs.chmodSync(endpoint, 0o600);
    fs.renameSync(endpoint, path.join(directory, 'original.sock'));
    fs.symlinkSync('original.sock', endpoint);
    assert.throws(() => resolveIpcEndpoint(options), /socket must be private/);
    fs.renameSync(directory, path.join(root, 'original-ipc'));
    fs.symlinkSync('original-ipc', directory);
    assert.throws(() => resolveIpcEndpoint(options), /directory must be private/);
  });

test('state patches reject invalid and out-of-range array indexes', () => {
  for (const [op, key] of [['add', 'not-an-index'], ['add', -1], ['add', 3], ['replace', 2], ['remove', '-']]) {
    const state = { values: ['a', 'b'] };
    assert.throws(() => applyPatches(state, [{ op, path: ['values', key], value: 'x' }]),
      /Invalid state patch array index/);
    assert.deepEqual(state, { values: ['a', 'b'] });
  }
});

test('state patches reject replacement or removal of absent object fields', () => {
  assert.throws(() => applyPatches({ value: {} }, [{ op: 'replace', path: ['value', 'missing'], value: 1 }]),
    /does not match snapshot/);
  assert.throws(() => applyPatches({ value: {} }, [{ op: 'remove', path: ['value', 'missing'] }]),
    /does not match snapshot/);
});

test('IPC rejects malformed UUID-shaped thread identifiers', () => {
  assert.throws(() => new CodexIpc('------------------------------------'), /Invalid thread ID/);
});

test('continuation identifies Rekall without the retired project name', () => {
  const text = continuationText({ jobId: 'job-1', handoff: { summary: 'done' } }, 'checkpoint.json');
  assert.match(text, /through Rekall/);
  assert.doesNotMatch(text, /context-compact/);
});
