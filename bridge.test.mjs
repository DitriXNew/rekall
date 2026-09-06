import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPatches, CodexIpc } from './ipc.mjs';
import { isIdle, completedCompactions, validateThreadId, validateJobId, replaceFileAtomically } from './bridge.mjs';
import { userBoundary, validateHandoff } from './handoff.mjs';

const threadId = '00000000-0000-4000-8000-000000000001';
const script = fileURLToPath(new URL('./bridge.mjs', import.meta.url));

test('idle requires an explicit idle runtime and no outstanding requests', () => {
  assert.equal(isIdle(null), false);
  assert.equal(isIdle({ threadRuntimeStatus: { type: 'active' }, requests: [] }), false);
  assert.equal(isIdle({ threadRuntimeStatus: { type: 'idle' }, requests: [{}] }), false);
  assert.equal(isIdle({ threadRuntimeStatus: { type: 'idle' } }), false);
  assert.equal(isIdle({ threadRuntimeStatus: { type: 'idle' }, requests: [] }), true);
  assert.equal(isIdle({ threadRuntimeStatus: { type: 'idle' }, requests: [], unconfirmedTurnSubmissions: [{ terminal: false }] }), false);
});

const handoff = { summary: 'Current authorized task and verified tests. Stop after the next verification.',
  preserve: ['Keep the exact next step and stop condition'], discard: ['Repeated tool output'],
  nextStep: 'Verify the completed compaction job and stop.', resume: true };

test('handoff requires explicit continuation and bounded, well-formed content', () => {
  assert.deepEqual(validateHandoff(handoff), handoff);
  assert.throws(() => validateHandoff({ ...handoff, resume: undefined }));
  assert.throws(() => validateHandoff({ ...handoff, nextStep: '' }));
  assert.throws(() => validateHandoff({ ...handoff, summary: '\u044f'.repeat(32000) }));
  assert.throws(() => validateHandoff({ ...handoff, extra: 'unrecognized' }));
  assert.equal(validateHandoff({ ...handoff, resume: false, nextStep: '' }).resume, false);
});

test('user boundary detects steering and stops but ignores old history and compaction turns', () => {
  const current = { turnId: 'current', turnStartedAtMs: 200, status: 'inProgress', params: { input: [{ type: 'text', text: 'work' }] }, items: [] };
  const state = { turnHistory: { kind: 'canonical', history: { islands: [{ entries: [{ value: 'now' }] }], entitiesByKey: { now: current } } }, turns: [] };
  const before = userBoundary(state);
  state.turns.push({ turnId: 'older', turnStartedAtMs: 100, params: { input: [{ type: 'text', text: 'earlier' }] } });
  state.turns.push({ turnId: 'compact', turnStartedAtMs: 300, params: { input: [] }, items: [{ type: 'contextCompaction' }] });
  assert.deepEqual(userBoundary(state), before);
  current.params.input.push({ type: 'text', text: 'stop' });
  assert.notEqual(userBoundary(state).fingerprint, before.fingerprint);
  current.status = 'interrupted';
  assert.equal(userBoundary(state).interrupted, true);
});

test('only completed compaction events count, across both history layouts', () => {
  const state = { turns: [{ items: [{ type: 'contextCompaction', id: 'old', completed: true }] }],
    turnHistory: { kind: 'canonical', history: { islands: [{ entries: [
      { value: { type: 'contextCompaction', id: 'new', completed: false } },
      { value: { type: 'contextCompaction', id: 'old', completed: true } },
    ] }] } } };
  assert.deepEqual([...completedCompactions(state)], ['old']);
  state.turnHistory.history.islands[0].entries[0].value.completed = true;
  assert.deepEqual([...completedCompactions(state)].sort(), ['new', 'old']);
});

test('incremental state patches preserve list insertion and removal order', () => {
  const state = { requests: ['a', 'c'], threadRuntimeStatus: { type: 'active' } };
  applyPatches(state, [
    { op: 'add', path: ['requests', 1], value: 'b' },
    { op: 'remove', path: ['requests', 0] },
    { op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'idle' },
  ]);
  assert.deepEqual(state, { requests: ['b', 'c'], threadRuntimeStatus: { type: 'idle' } });
});

test('malformed patches and path traversal thread IDs fail closed', () => {
  assert.throws(() => applyPatches({}, [{ op: 'add', path: ['__proto__', 'polluted'], value: true }]));
  assert.throws(() => applyPatches({}, [{ op: 'replace', path: ['missing', 'key'], value: 1 }]));
  assert.throws(() => validateThreadId('../../config.toml'));
  assert.throws(() => validateThreadId(undefined));
  assert.throws(() => validateJobId('../../job'), /Invalid job ID/);
  assert.doesNotThrow(() => validateJobId(randomUUID()));
  assert.equal({}.polluted, undefined);
});

test('Windows atomic status replacement retries only bounded transient local failures', () => {
  let attempts = 0;
  const pauses = [];
  replaceFileAtomically('source', 'target', {
    platform: 'win32', delays: [10, 20], pause: value => pauses.push(value),
    rename: () => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error('temporarily busy'), { code: 'EPERM' });
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(pauses, [10, 20]);

  attempts = 0;
  assert.throws(() => replaceFileAtomically('source', 'target', {
    platform: 'win32', delays: [1, 2], pause: () => {},
    rename: () => { attempts++; throw Object.assign(new Error('still busy'), { code: 'EBUSY' }); },
  }), /still busy/);
  assert.equal(attempts, 3);

  attempts = 0;
  assert.throws(() => replaceFileAtomically('source', 'target', {
    platform: 'linux', delays: [1, 2], pause: () => {},
    rename: () => { attempts++; throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  }), /denied/);
  assert.equal(attempts, 1);
});

test('foreign owners, threads and protocol versions cannot change observed state', () => {
  const ipc = new CodexIpc(threadId);
  ipc.ownerId = 'owner';
  const message = { type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
    sourceClientId: 'owner', params: { hostId: 'local', conversationId: threadId,
      change: { type: 'snapshot', revision: 1, conversationState: { requests: [], threadRuntimeStatus: { type: 'idle' } } } } };
  ipc.receiveBroadcast({ ...message, sourceClientId: 'other-owner' });
  ipc.receiveBroadcast({ ...message, version: 12 });
  ipc.receiveBroadcast({ ...message, params: { ...message.params, conversationId: randomUUID() } });
  assert.equal(ipc.state, null);
  ipc.receiveBroadcast(message);
  assert.equal(isIdle(ipc.state), true);
});

async function until(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Test deadline exceeded');
}

async function exercise(t, scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compact-test-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\codex-compact-test-${randomUUID()}` : path.join(root, 'ipc.sock');
  const ownerId = randomUUID();
  const sockets = new Set();
  const followers = new Set();
  let active = true, complete = false, compactRequests = 0, resumeRequests = 0, revision = 0;
  let userText = 'original request', stopped = false, resumeText, telemetryDegraded = false;
  const tokenUsage = () => {
    if (!complete) return { last: { totalTokens: 90000 }, modelContextWindow: 100000 };
    if (scenario === 'missing_telemetry') return undefined;
    if (scenario === 'stale_telemetry') return { last: { totalTokens: 90000 }, modelContextWindow: 100000 };
    if (scenario === 'low_headroom') return { last: { totalTokens: 61000 }, modelContextWindow: 100000 };
    if (scenario === 'exact_headroom') return { last: { totalTokens: 60000 }, modelContextWindow: 100000 };
    if (scenario === 'telemetry_degrades' && telemetryDegraded) {
      return { last: { totalTokens: 70000 }, modelContextWindow: 100000 };
    }
    return { last: { totalTokens: 10000 }, modelContextWindow: 100000 };
  };
  const send = (socket, message) => {
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    // Deliberately split headers and payloads to test stream framing.
    socket.write(header.subarray(0, 2)); socket.write(Buffer.concat([header.subarray(2), body]));
  };
  const snapshot = socket => send(socket, {
    type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: ownerId, version: 11,
    params: { hostId: 'local', conversationId: threadId, change: { type: 'snapshot', revision: ++revision,
      conversationState: { requests: [], threadRuntimeStatus: { type: active ? 'active' : 'idle' },
        latestTokenUsageInfo: tokenUsage(),
        turns: [{ turnId: 'user-turn', turnStartedAtMs: 100, status: stopped ? 'interrupted' : 'completed',
          params: { input: [{ type: 'text', text: userText }] }, items: [] },
          { items: [{ type: 'contextCompaction', id: 'old', completed: true },
          ...(compactRequests ? [{ type: 'contextCompaction', id: 'new', completed: complete }] : [])] }],
      } } },
  });
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); followers.delete(socket); });
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const length = buffer.readUInt32LE();
        const message = JSON.parse(buffer.subarray(4, 4 + length)); buffer = buffer.subarray(4 + length);
        if (message.type === 'request') {
          let result = {};
          if (message.method === 'initialize') result = { clientId: randomUUID() };
          else if (message.method === 'thread-owner-discovery') {
            assert.equal(message.params.conversationId, threadId);
          } else if (message.method === 'thread-follower-compact-thread') {
            assert.equal(active, false, 'must not interrupt active work');
            assert.equal(message.params.conversationId, threadId);
            assert.equal(message.targetClientId, ownerId);
            assert.equal(message.hostId, 'local');
            assert.equal(message.version, 2);
            compactRequests++;
            result = { ok: true };
          } else if (message.method === 'thread-follower-start-turn') {
            assert.equal(complete, true, 'completion must precede continuation');
            assert.equal(active, false, 'must wait until idle after completion');
            assert.equal(message.targetClientId, ownerId);
            assert.equal(message.hostId, 'local');
            assert.equal(message.version, 3);
            assert.equal(message.params.conversationId, threadId);
            const start = message.params.turnStart;
            assert.equal(start.request.threadId, threadId);
            assert.equal(start.context.inheritThreadSettings, true);
            assert.equal(start.request.approvalPolicy, undefined, 'must inherit permissions');
            assert.equal(start.request.model, undefined, 'must inherit model');
            resumeRequests++;
            resumeText = start.request.input[0].text;
            assert.ok(resumeText.includes(handoff.nextStep));
            assert.ok(resumeText.includes(handoff.preserve[0]));
            assert.ok(resumeText.includes(start.request.clientUserMessageId));
            if (scenario === 'resume_disconnect') { socket.destroy(); continue; }
            result = scenario === 'resume_bad_ack' ? { ok: true } : { result: { turn: { id: 'resumed-turn', status: 'inProgress' } } };
            active = true;
            userText = 'automatic continuation';
            for (const follower of followers) snapshot(follower);
          } else assert.fail(`Unexpected request ${message.method}`);
          send(socket, { type: 'response', requestId: message.requestId, method: message.method,
            resultType: 'success', handledByClientId: ownerId, result });
          if (message.method === 'thread-follower-compact-thread') for (const follower of followers) snapshot(follower);
        } else if (message.method === 'thread-stream-following-changed') {
          followers.add(socket); snapshot(socket);
        }
      }
    });
  });
  await new Promise(resolve => server.listen(endpoint, resolve));
  const child = spawn(process.execPath, [script, 'mcp'], { windowsHide: true,
    env: { ...process.env, REKALL_PIPE: endpoint, REKALL_JOBS_DIR: root },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', nextId = 0, workerPid;
  const responses = new Map();
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    stdout += data;
    for (;;) {
      const newline = stdout.indexOf('\n'); if (newline < 0) break;
      const message = JSON.parse(stdout.slice(0, newline)); stdout = stdout.slice(newline + 1);
      responses.set(message.id, message);
    }
  });
  t.after(async () => {
    child.kill();
    if (workerPid) { try { process.kill(workerPid); } catch {} }
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    // Only the exact directory created by this test is removed.
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const rpc = async (method, params = {}) => {
    const id = ++nextId; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const response = await until(() => responses.get(id));
    assert.equal(response.result?.isError, undefined, JSON.stringify(response));
    return response.result;
  };
  const tool = async (name, args = {}) => JSON.parse((await rpc('tools/call', { name, arguments: { threadId, ...args } })).content[0].text);
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.serverInfo.name, 'rekall');
  assert.equal(init.serverInfo.version, '0.3.1');
  assert.equal((await rpc('tools/list')).tools.length, 4);
  const options = scenario === 'compact_only' ? {} : { handoff: { ...handoff, resume: scenario !== 'handoff_without_resume' } };
  const job = await tool('schedule_compaction', options); workerPid = job.pid;
  const statusFile = path.join(root, `${threadId}.json`);
  const readJob = () => JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  await until(() => {
    const current = readJob();
    if (['failed', 'cancelled'].includes(current.status)) assert.fail(JSON.stringify(current));
    return current.status === 'waiting_for_idle' && followers.size > 0;
  }).catch(error => { throw new Error(`${error.message}; last job: ${JSON.stringify(readJob())}; stderr: ${stderr}`); });
  assert.equal(compactRequests, 0);
  const duplicate = await tool('schedule_compaction');
  assert.equal(duplicate.alreadyScheduled, true);
  assert.equal(duplicate.jobId, job.jobId);
  if (options.handoff) {
    assert.deepEqual(JSON.parse(fs.readFileSync(job.handoffPath, 'utf8')).handoff, options.handoff);
    assert.equal(readJob().summary, undefined, 'status must not include handoff text');
  }
  const broadcast = () => { for (const socket of followers) snapshot(socket); };
  if (['new_input_before', 'stopped_before', 'cancel_before'].includes(scenario)) {
    if (scenario === 'new_input_before') userText = 'new user instruction';
    if (scenario === 'stopped_before') stopped = true;
    if (scenario === 'cancel_before') await tool('cancel_compaction', { jobId: job.jobId });
    broadcast();
    await until(() => readJob().status === 'cancelled');
    assert.equal(compactRequests, 0);
    assert.equal(resumeRequests, 0);
    await until(() => !fs.existsSync(path.join(root, `${threadId}.lock`)));
    return;
  }
  active = false; for (const socket of followers) snapshot(socket);
  await until(() => readJob().status === 'accepted');
  assert.equal(compactRequests, 1);
  assert.equal((await tool('compaction_status')).status, 'accepted', 'acknowledgment is not completion');
  if (scenario === 'new_input_during') {
    userText = 'stop during compaction'; broadcast();
    await until(() => readJob().status === 'cancelled');
    assert.equal(resumeRequests, 0);
    assert.equal(readJob().outcomeMayBeUnknown, true);
    return;
  }
  if (scenario === 'tampered_handoff') fs.appendFileSync(job.handoffPath, ' ');
  complete = true;
  active = options.handoff?.resume === true;
  broadcast();
  if (['low_headroom', 'missing_telemetry', 'stale_telemetry'].includes(scenario)) {
    await until(() => readJob().status === 'completed');
    assert.equal(readJob().resumeSkipped, 'insufficient_headroom');
    assert.equal(resumeRequests, 0);
    assert.equal(readJob().jobNumber, 1);
    return;
  }
  if (active) {
    await until(() => readJob().status === 'waiting_for_resume_idle');
    assert.equal(resumeRequests, 0);
    if (scenario === 'new_input_after') {
      userText = 'a new task takes priority'; broadcast();
      await until(() => readJob().status === 'cancelled');
      assert.equal(resumeRequests, 0);
      assert.equal(readJob().outcomeMayBeUnknown, false);
      return;
    }
    active = false;
    if (scenario === 'telemetry_degrades') telemetryDegraded = true;
    broadcast();
    if (scenario === 'telemetry_degrades') {
      await until(() => readJob().status === 'completed');
      assert.equal(readJob().resumeSkipped, 'insufficient_headroom');
      assert.equal(readJob().resumeSkipReason, 'more_than_60_percent_used');
      assert.equal(readJob().contextTokensAfter, 10000);
      assert.equal(readJob().resumeCheckContextTokens, 70000);
      assert.equal(resumeRequests, 0);
      return;
    }
  }
  const expected = ['tampered_handoff', 'resume_bad_ack', 'resume_disconnect'].includes(scenario) ? 'failed' : options.handoff?.resume ? 'resumed' : 'completed';
  await until(() => readJob().status === expected);
  assert.equal(readJob().compactionId, 'new');
  assert.equal(compactRequests, 1);
  assert.equal(resumeRequests, expected === 'resumed' || scenario.startsWith('resume_') ? 1 : 0);
  if (expected === 'resumed') {
    assert.equal(readJob().resumeTurnId, 'resumed-turn');
    assert.ok(resumeText.includes(job.handoffPath));
    const expectedReclaimed = scenario === 'exact_headroom' ? 30000 : 80000;
    assert.equal(readJob().tokensReclaimed, expectedReclaimed);
    assert.equal(readJob().reclaimedFraction, expectedReclaimed / 90000);
    assert.ok(readJob().compactionDurationMs >= 0);
    assert.ok(readJob().resumeDelayMs >= 0);
  }
  if (scenario.startsWith('resume_')) assert.equal(readJob().outcomeMayBeUnknown, true);
  if (scenario === 'tampered_handoff') assert.equal(readJob().outcomeMayBeUnknown, false);
  await until(() => !fs.existsSync(path.join(root, `${threadId}.lock`)));
  assert.equal(stderr, '');
  if (scenario === 'compact_only') {
    const next = await tool('schedule_compaction');
    workerPid = next.pid;
    assert.equal(next.jobNumber, 2);
    assert.equal(next.history.length, 1);
    assert.equal(next.history[0].jobId, job.jobId);
    assert.equal(next.history[0].tokensReclaimed, 80000);
    await tool('cancel_compaction', { jobId: next.jobId });
    await until(() => readJob().status === 'cancelled');
  }
}

for (const scenario of ['compact_only', 'resume', 'handoff_without_resume', 'new_input_before', 'stopped_before',
  'cancel_before', 'new_input_during', 'new_input_after', 'tampered_handoff', 'resume_bad_ack', 'resume_disconnect']) {
  test(`MCP + detached worker: ${scenario}`, { timeout: 20000 }, t => exercise(t, scenario));
}

for (const scenario of ['low_headroom', 'missing_telemetry', 'stale_telemetry', 'exact_headroom', 'telemetry_degrades']) {
  test(`automatic resume headroom: ${scenario}`, { timeout: 20000 }, t => exercise(t, scenario));
}
