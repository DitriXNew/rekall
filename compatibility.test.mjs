import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { inspectRuntimeCompatibility, inspectPublicSchema, findCodexBinary, probeCompatibility,
  verifiedExtensionVersion } from './compatibility.mjs';

function fixtures() {
  const item = { properties: { type: { enum: ['contextCompaction'] }, id: { type: 'string' } }, required: ['type', 'id'] };
  const requests = { definitions: { Params: { properties: { threadId: { type: 'string' } }, required: ['threadId'] } },
    oneOf: [{ properties: { method: { enum: ['thread/compact/start'] }, params: { $ref: '#/definitions/Params' } } }] };
  const notifications = { definitions: { Item: { oneOf: [item] },
    Params: { required: ['threadId', 'turnId', 'item'], properties: { item: { $ref: '#/definitions/Item' } } } },
    oneOf: ['item/started', 'item/completed'].map(method => ({ properties: {
      method: { enum: [method] }, params: { $ref: '#/definitions/Params' },
    } })) };
  return { requests, notifications };
}

test('public lifecycle schema is distinct from internal completion flags', () => {
  const { requests, notifications } = fixtures();
  assert.equal(inspectPublicSchema(requests, notifications).status, 'compatible');
  const state = { requests: [], threadRuntimeStatus: { type: 'idle' }, turns: [] };
  assert.equal(inspectRuntimeCompatibility(state).completionFieldObserved, false);
  state.turns.push({ items: [{ type: 'contextCompaction', id: 'synthetic', completed: false }] });
  assert.equal(inspectRuntimeCompatibility(state).completionFieldObserved, true);
  delete state.turns[0].items[0].completed;
  assert.throws(() => inspectRuntimeCompatibility(state), /boolean completed/);
  assert.throws(() => inspectRuntimeCompatibility({}), /state layout/);
});

test('schema drift fails before a compaction is scheduled', () => {
  let { requests, notifications } = fixtures();
  notifications.oneOf.pop();
  assert.throws(() => inspectPublicSchema(requests, notifications), /item\/completed/);
  ({ requests, notifications } = fixtures());
  notifications.definitions.Item.oneOf[0].properties.type.enum = ['differentItem'];
  assert.throws(() => inspectPublicSchema(requests, notifications), /lifecycle/);
  ({ requests, notifications } = fixtures());
  requests.definitions.Params.required.push('newMandatoryField');
  assert.throws(() => inspectPublicSchema(requests, notifications), /different request/);
});

test('binary discovery refuses a guessed CLI or relative override', () => {
  assert.throws(() => findCodexBinary({ PATH: '' }), /Cannot identify/);
  assert.throws(() => findCodexBinary({ REKALL_CODEX_BINARY: 'codex.exe' }), /absolute path/);
});

test('binary discovery selects extension executables on Windows, macOS, and Linux', () => {
  for (const [platform, directory, binary] of [
    ['win32', 'C:\\extensions\\openai.chatgpt-26.901.22334-win32-x64\\bin\\windows-x86_64', 'codex.exe'],
    ['darwin', '/extensions/openai.chatgpt-26.901.22334-darwin-arm64/bin/macos-aarch64', 'codex'],
    ['darwin', '/extensions/openai.chatgpt-26.901.22334-darwin-x64/bin/macos-x86_64', 'codex'],
    ['linux', '/extensions/openai.chatgpt-26.901.22334-linux-x64/bin/linux-x86_64', 'codex'],
    ['linux', '/extensions/openai.chatgpt-26.901.22334-linux-arm64/bin/linux-aarch64', 'codex'],
  ]) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const expected = paths.join(directory, binary);
    const env = { Path: [paths.parse(directory).root + 'unrelated', directory, directory + paths.sep].join(paths.delimiter) };
    assert.equal(findCodexBinary(env, { platform, existsSync: file => file === expected }), expected);
    assert.equal(findCodexBinary({ REKALL_CODEX_BINARY: expected }, { platform, existsSync: file => file === expected }), expected);
    assert.throws(() => findCodexBinary({ REKALL_CODEX_BINARY: binary }, { platform, existsSync: () => true }), /absolute path/);
    assert.throws(() => findCodexBinary(env, { platform, existsSync: () => false }), /Cannot identify/);
    const second = directory.replace('26.901.22334', '99.0.0');
    assert.throws(() => findCodexBinary({ PATH: [directory, second].join(paths.delimiter) },
      { platform, existsSync: () => true }), /Cannot identify one/);
  }
});

test('binary discovery ignores relative and nested lookalike extension paths', () => {
  for (const directory of ['openai.chatgpt-test/bin/macos-aarch64',
    '/extensions/openai.chatgpt-test/bin/macos-aarch64/unrelated', '/usr/local/bin']) {
    assert.throws(() => findCodexBinary({ PATH: directory }, { platform: 'darwin', existsSync: () => true }), /Cannot identify/);
  }
});

function probeFixture({ version = verifiedExtensionVersion, publisher = 'openai', name = 'chatgpt',
  env = {}, requests, notifications, state } = {}) {
  const schemas = fixtures();
  const manifest = { publisher, name, version };
  const files = new Map([
    ['package.json', manifest],
    ['ClientRequest.json', requests ?? schemas.requests],
    ['ServerNotification.json', notifications ?? schemas.notifications],
  ]);
  let removed = false;
  const result = probeCompatibility(state ?? {
    requests: [], threadRuntimeStatus: { type: 'idle' }, turns: [],
  }, {
    env,
    binary: 'C:\\fixture\\openai.chatgpt\\bin\\codex.exe',
    execute: async () => {},
    mkdtempSync: () => path.join(os.tmpdir(), 'rekall-schema-test'),
    rmSync: () => { removed = true; },
    readFileSync: file => JSON.stringify(files.get(file.split(/[\\/]/).at(-1))),
  });
  return { result, wasRemoved: () => removed };
}

test('unknown extension version is rejected by default and exact opt-in returns a warning', async () => {
  await assert.rejects(probeFixture({ version: '99.0.0' }).result, /Unverified Codex extension version 99\.0\.0/);
  await assert.rejects(probeFixture({ version: '99.0.0', env: { REKALL_ALLOW_UNVERIFIED: 'true' } }).result,
    /Unverified Codex extension version/);

  const fixture = probeFixture({ version: '99.0.0', env: { REKALL_ALLOW_UNVERIFIED: '1' } });
  const result = await fixture.result;
  assert.equal(result.versionVerification.status, 'unverified_override');
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(result.warnings[0], {
    severity: 'warning',
    code: 'UNVERIFIED_EXTENSION_VERSION_OVERRIDE',
    message: 'REKALL_ALLOW_UNVERIFIED=1 bypassed version verification for Codex extension 99.0.0; internal IPC compatibility is not established',
    extensionVersion: '99.0.0',
    verifiedExtensionVersion,
  });
  assert.equal(result.publicSchema.status, 'compatible');
  assert.equal(fixture.wasRemoved(), true);
});

test('verified extension version has no compatibility warning', async () => {
  const { result } = probeFixture();
  const value = await result;
  assert.equal(value.versionVerification.status, 'verified');
  assert.deepEqual(value.warnings, []);
});

test('version opt-in does not bypass identity, runtime, or schema safety checks', async () => {
  const env = { REKALL_ALLOW_UNVERIFIED: '1' };
  await assert.rejects(probeFixture({ version: '99.0.0', publisher: 'third-party', env }).result,
    /Unexpected extension identity third-party\.chatgpt/);
  await assert.rejects(probeFixture({ version: '99.0.0', env, state: {} }).result, /state layout/);
  await assert.rejects(probeFixture({ version: '99.0.0', env, state: {
    requests: [], threadRuntimeStatus: { type: 'idle' },
    turns: [{ items: [{ type: 'contextCompaction', id: 'synthetic' }] }],
  } }).result, /boolean completed/);

  const { requests, notifications } = fixtures();
  notifications.oneOf.pop();
  await assert.rejects(probeFixture({ version: '99.0.0', env, requests, notifications }).result,
    /item\/completed/);
});
