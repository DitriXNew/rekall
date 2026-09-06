import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { CodexIpc } from './ipc.mjs';
import { digest, validateHandoff, userBoundary, continuationText } from './handoff.mjs';
import { inspectRuntimeCompatibility, probeCompatibility } from './compatibility.mjs';

const script = fileURLToPath(import.meta.url);
const directory = path.dirname(script);
// Keep private handoffs and locks outside the checkout, stable across code updates.
const codexDirectory = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const legacyJobsDirectory = path.join(codexDirectory, 'tools', 'context-compact', 'jobs');
const rekallJobsDirectory = path.join(codexDirectory, 'tools', 'rekall', 'jobs');
const jobsDirectory = process.env.REKALL_JOBS_DIR ?? process.env.CONTEXT_COMPACT_JOBS_DIR ??
  (fs.existsSync(legacyJobsDirectory) ? legacyJobsDirectory : rekallJobsDirectory);
const makeIpc = threadId => new CodexIpc(threadId,
  process.env.REKALL_PIPE || process.env.CONTEXT_COMPACT_PIPE ?
    { endpoint: process.env.REKALL_PIPE ?? process.env.CONTEXT_COMPACT_PIPE } : undefined);

export function validateThreadId(threadId) {
  if (typeof threadId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) {
    throw new Error('Pass the current CODEX_THREAD_ID explicitly; invalid thread ID');
  }
  return threadId;
}

export function validateJobId(jobId) {
  if (typeof jobId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(jobId)) {
    throw new Error('Invalid job ID; copy jobId from compaction_status');
  }
  return jobId;
}

export function completedCompactions(state) {
  const found = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'contextCompaction' && value.completed === true && typeof value.id === 'string') {
      found.add(value.id);
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(state?.turnHistory);
  visit(state?.turns);
  return found;
}

export function isIdle(state) {
  return state?.threadRuntimeStatus?.type === 'idle' && Array.isArray(state.requests) && state.requests.length === 0 &&
    !state.unconfirmedTurnSubmissions?.some(item => item.terminal !== true);
}

function statusPath(threadId) { return path.join(jobsDirectory, `${validateThreadId(threadId)}.json`); }
function lockPath(threadId) { return path.join(jobsDirectory, `${validateThreadId(threadId)}.lock`); }
const terminal = new Set(['completed', 'resumed', 'failed', 'cancelled']);
function jobFile(threadId, jobId, suffix) {
  return path.join(jobsDirectory, `${validateThreadId(threadId)}.${validateJobId(jobId)}.${suffix}`);
}

export function cancel(threadId, jobId) {
  const job = readStatus(threadId);
  if (job.jobId !== validateJobId(jobId)) throw new Error('Job identity mismatch; inspect current status');
  if (terminal.has(job.status)) return { ...job, cancellationRequested: false };
  fs.writeFileSync(jobFile(threadId, jobId, 'cancel'), 'cancel');
  return { threadId, jobId, cancellationRequested: true,
    message: 'Stops pending dispatches. Already sent requests cannot be retracted; check status.' };
}

export function readStatus(threadId) {
  try { return JSON.parse(fs.readFileSync(statusPath(threadId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { threadId, status: 'not_scheduled' }; throw error; }
}

function writeStatus(job) {
  const target = statusPath(job.threadId);
  const temporary = `${target}.${job.jobId}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...job, updatedAt: new Date().toISOString() }, null, 2));
  replaceFileAtomically(temporary, target);
}

export function replaceFileAtomically(source, target, options = {}) {
  const rename = options.rename ?? fs.renameSync;
  const platform = options.platform ?? process.platform;
  const delays = options.delays ?? [10, 20, 40, 80, 100];
  const pause = options.pause ?? (milliseconds =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds));
  let retries = 0;
  for (;;) {
    try { rename(source, target); return; }
    catch (error) {
      const transient = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
      if (platform !== 'win32' || !transient || retries >= delays.length) throw error;
      pause(delays[retries++]);
    }
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function probe(threadId) {
  const ipc = makeIpc(validateThreadId(threadId));
  try {
    await ipc.connect();
    const state = await ipc.snapshot();
    return { threadId, connected: true, ownerId: ipc.ownerId,
      runtimeStatus: state.threadRuntimeStatus?.type ?? 'unknown',
      completedCompactions: completedCompactions(state).size,
      contextTokens: state.latestTokenUsageInfo?.last?.totalTokens ?? null,
      modelContextWindow: state.latestTokenUsageInfo?.modelContextWindow ?? null,
      compatibility: await probeCompatibility(state),
    };
  } finally { ipc.close(); }
}

export async function schedule(threadId, handoffValue) {
  validateThreadId(threadId);
  const handoff = validateHandoff(handoffValue);
  // Prove that this exact live thread has an owner before spawning anything.
  const ipc = makeIpc(threadId);
  let anchor;
  try {
    await ipc.connect();
    const state = await ipc.snapshot();
    anchor = userBoundary(state);
    await probeCompatibility(state);
    // Schema generation can overlap new input; do not adopt a changed boundary.
    inspectRuntimeCompatibility(ipc.state);
    const latest = userBoundary(ipc.state);
    if (latest.fingerprint !== anchor.fingerprint || latest.interrupted) {
      throw new Error('User input changed during compatibility checks; no job scheduled');
    }
  }
  finally { ipc.close(); }
  if (anchor.interrupted) throw new Error('Latest user turn was stopped or failed; do not schedule continuation');
  fs.mkdirSync(jobsDirectory, { recursive: true });
  const previous = readStatus(threadId);
  const jobId = randomUUID();
  const previousHistory = Array.isArray(previous.history) ? previous.history : [];
  const previousSummary = terminal.has(previous.status) ? {
    jobId: previous.jobId, jobNumber: previous.jobNumber, status: previous.status,
    createdAt: previous.createdAt, completedAt: previous.completedAt ?? previous.resumedAt ?? previous.failedAt ?? previous.cancelledAt,
    contextTokensBefore: previous.contextTokensBefore ?? null,
    contextTokensAfter: previous.contextTokensAfter ?? null,
    tokensReclaimed: previous.tokensReclaimed ?? null,
    reclaimedFraction: previous.reclaimedFraction ?? null,
    compactionDurationMs: previous.compactionDurationMs ?? null,
    resumeDelayMs: previous.resumeDelayMs ?? null,
    resumeSkipped: previous.resumeSkipped,
  } : null;
  const job = { jobId, threadId, status: 'scheduled', createdAt: new Date().toISOString(),
    userFingerprint: anchor.fingerprint, resume: handoff?.resume === true,
    jobNumber: Number.isInteger(previous.jobNumber) ? previous.jobNumber + 1 : 1,
    history: previousSummary ? [...previousHistory, previousSummary].slice(-20) : previousHistory.slice(-20) };
  let lock;
  try {
    lock = fs.openSync(lockPath(threadId), 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = readStatus(threadId);
    if (alive(existing.pid) && !terminal.has(existing.status)) {
      return { ...existing, alreadyScheduled: true };
    }
    // A lock can belong to a schedule call still starting its worker. Do not
    // delete or steal it. Manual stale-lock recovery is described in README.
    throw new Error('An existing job lock needs inspection; use compaction_status');
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ jobId, threadId }));
    fs.closeSync(lock);
    lock = undefined;
    if (handoff) {
      const record = JSON.stringify({ version: 1, threadId, jobId, handoff }, null, 2);
      job.handoffPath = jobFile(threadId, jobId, 'handoff.json');
      job.handoffSha256 = digest(record);
      fs.writeFileSync(job.handoffPath, record, { flag: 'wx' });
    }
    writeStatus(job);
    const child = spawn(process.execPath, [script, 'worker', threadId, jobId], {
      detached: true, windowsHide: true, stdio: 'ignore', cwd: directory,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { ...job, pid: child.pid, handoff,
      message: 'Queued once. Keep this handoff in the compaction summary. The immutable file is reintroduced on continuation. Waits for idle; acceptance is not completion.' };
  } catch (error) {
    if (lock !== undefined) fs.closeSync(lock);
    fs.rmSync(lockPath(threadId), { force: true });
    throw error;
  }
}

async function worker(threadId, jobId) {
  validateJobId(jobId);
  const initial = readStatus(threadId);
  if (initial.jobId !== jobId) throw new Error('Job identity mismatch');
  let job = { ...initial, pid: process.pid, status: 'waiting_for_idle' };
  const update = fields => { job = { ...job, ...fields }; writeStatus(job); };
  const ipc = makeIpc(threadId);
  let idleTimer, deadlineTimer, cancellationTimer;
  let resolveOutcome, rejectOutcome;
  const outcome = new Promise((resolve, reject) => { resolveOutcome = resolve; rejectOutcome = reject; });
  outcome.catch(() => {});
  let requested = false, resumeRequested = false, settled = false;
  let baseline, phase = 'waiting_for_idle';
  const finish = fields => { if (!settled) { settled = true; resolveOutcome(fields); } };
  const fail = error => { if (!settled) { settled = true; rejectOutcome(error); } };
  const cancelled = reason => finish({ status: 'cancelled', reason, cancelledAt: new Date().toISOString(),
    outcomeMayBeUnknown: (requested && !job.compactionId) || resumeRequested });
  const checkCancellation = state => {
    if (settled) return true;
    if (fs.existsSync(jobFile(threadId, jobId, 'cancel'))) { cancelled('explicit_cancellation'); return true; }
    // Once the resume was sent, its own input changes the boundary. Never send a
    // second request; uncertainty is reported instead of retried.
    if (!resumeRequested && state) {
      const anchor = userBoundary(state);
      if (anchor.fingerprint !== initial.userFingerprint || anchor.interrupted) {
        cancelled(anchor.interrupted ? 'user_turn_stopped' : 'new_user_input'); return true;
      }
    }
    return false;
  };
  const readHandoff = () => {
    const file = jobFile(threadId, jobId, 'handoff.json');
    const raw = fs.readFileSync(file, 'utf8');
    if (digest(raw) !== job.handoffSha256) throw new Error('Saved handoff changed; continuation cancelled');
    const record = JSON.parse(raw);
    if (record.version !== 1 || record.threadId !== threadId || record.jobId !== jobId || !validateHandoff(record.handoff)?.resume) {
      throw new Error('Saved handoff does not authorize this continuation');
    }
    return { record, file };
  };
  const tokenTelemetry = state => {
    const tokens = state?.latestTokenUsageInfo?.last?.totalTokens;
    const window = state?.latestTokenUsageInfo?.modelContextWindow;
    if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(window) || window <= 0) {
      return { safe: false, reason: 'missing_token_telemetry', tokens: tokens ?? null, window: window ?? null };
    }
    if (Number.isFinite(job.contextTokensBefore) && tokens >= job.contextTokensBefore) {
      return { safe: false, reason: 'stale_or_unreclaimed_token_telemetry', tokens, window };
    }
    const usedFraction = tokens / window;
    return { safe: usedFraction <= 0.6, reason: usedFraction > 0.6 ? 'more_than_60_percent_used' : null,
      tokens, window, usedFraction };
  };
  const completionMetrics = (fields, now = Date.now()) => {
    const before = job.contextTokensBefore;
    const after = fields.contextTokensAfter;
    const reclaimed = Number.isFinite(before) && Number.isFinite(after) ? before - after : null;
    return {
      tokensReclaimed: reclaimed,
      reclaimedFraction: reclaimed !== null && before > 0 ? reclaimed / before : null,
      compactionDurationMs: job.requestedAt ? now - Date.parse(job.requestedAt) : null,
    };
  };
  const inspect = state => {
    if (!baseline || checkCancellation(state)) return;
    try { inspectRuntimeCompatibility(state); } catch (error) { fail(error); return; }
    if (phase === 'accepted') {
      const newIds = [...completedCompactions(state)].filter(id => !baseline.has(id));
      if (newIds.length) {
        const completedNow = Date.now();
        const fields = { compactionId: newIds.at(-1), compactionCompletedAt: new Date(completedNow).toISOString(),
          contextTokensAfter: state.latestTokenUsageInfo?.last?.totalTokens ?? null,
          modelContextWindowAfter: state.latestTokenUsageInfo?.modelContextWindow ?? null };
        Object.assign(fields, completionMetrics(fields, completedNow));
        if (!job.resume) { finish({ status: 'completed', ...fields, completedAt: fields.compactionCompletedAt }); return; }
        const telemetry = tokenTelemetry(state);
        if (!telemetry.safe) {
          finish({ status: 'completed', ...fields, completedAt: fields.compactionCompletedAt,
            resumeSkipped: 'insufficient_headroom', resumeSkipReason: telemetry.reason,
            contextWindowUsedFraction: telemetry.usedFraction ?? null });
          return;
        }
        phase = 'waiting_for_resume_idle';
        update({ ...fields, status: phase, contextWindowUsedFraction: telemetry.usedFraction });
      }
    }
    if (!['waiting_for_idle', 'waiting_for_resume_idle'].includes(phase)) return;
    if (!isIdle(state)) { clearTimeout(idleTimer); idleTimer = undefined; return; }
    if (idleTimer) return;
    idleTimer = setTimeout(async () => {
      idleTimer = undefined;
      try {
        if (checkCancellation(ipc.state) || !isIdle(ipc.state)) return;
        if (phase === 'waiting_for_idle') {
          baseline = completedCompactions(ipc.state);
          requested = true;
          phase = 'requesting';
          update({ status: phase, requestedAt: new Date().toISOString(),
            contextTokensBefore: ipc.state.latestTokenUsageInfo?.last?.totalTokens ?? null });
          await ipc.compact();
          if (settled) return;
          phase = 'accepted';
          update({ status: phase, acceptedAt: new Date().toISOString() });
          inspect(ipc.state);
        } else if (phase === 'waiting_for_resume_idle') {
          const { record, file } = readHandoff();
          if (checkCancellation(ipc.state) || !isIdle(ipc.state)) return;
          const telemetry = tokenTelemetry(ipc.state);
          if (!telemetry.safe) {
            finish({ status: 'completed', completedAt: new Date().toISOString(),
              resumeSkipped: 'insufficient_headroom', resumeSkipReason: telemetry.reason,
              resumeCheckContextTokens: telemetry.tokens, resumeCheckModelContextWindow: telemetry.window,
              resumeCheckWindowUsedFraction: telemetry.usedFraction ?? null });
            return;
          }
          resumeRequested = true;
          phase = 'resuming';
          update({ status: phase, resumeRequestedAt: new Date().toISOString() });
          const turn = await ipc.startTurn(continuationText(record, file), jobId);
          const resumedAt = Date.now();
          finish({ status: 'resumed', resumeTurnId: turn.id, resumedAt: new Date(resumedAt).toISOString(),
            resumeDelayMs: job.compactionCompletedAt ? resumedAt - Date.parse(job.compactionCompletedAt) : null });
        }
      } catch (error) { fail(error); }
    }, 750);
  };
  try {
    update({});
    deadlineTimer = setTimeout(() => fail(new Error('Deadline exceeded; no automatic retry')), 15 * 60 * 1000);
    cancellationTimer = setInterval(() => {
      try { checkCancellation(ipc.state); } catch (error) { fail(error); }
    }, 100);
    ipc.on('connectionFailure', fail);
    ipc.on('state', inspect);
    await ipc.connect();
    const state = await ipc.snapshot();
    baseline = completedCompactions(state);
    inspect(state);
    const result = await outcome;
    update(result);
  } catch (error) {
    update({ status: 'failed', error: error.message,
      outcomeMayBeUnknown: (requested && !job.compactionId) || resumeRequested, failedAt: new Date().toISOString() });
    process.exitCode = 1;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(deadlineTimer);
    clearInterval(cancellationTimer);
    ipc.off('connectionFailure', fail);
    ipc.close();
    // Remove only this job's lock. Recovery copies and other jobs stay intact.
    try {
      if (JSON.parse(fs.readFileSync(lockPath(threadId), 'utf8')).jobId === jobId) {
        fs.rmSync(lockPath(threadId));
      }
    } catch (error) { if (error.code !== 'ENOENT') process.exitCode = 1; }
  }
}

const schema = { type: 'object', properties: {
  threadId: { type: 'string', description: 'Current CODEX_THREAD_ID; obtain from the shell environment. Never guess or select a different thread.' },
}, required: ['threadId'], additionalProperties: false };
const handoffSchema = { type: 'object', additionalProperties: false,
  description: 'Optional verified handoff saved for this job. It guides the resumed agent but does not alter the extension compaction prompt.',
  properties: {
    summary: { type: 'string', description: 'Current task, constraints, decisions, completed work, verification and outstanding work. Maximum handoff size: 32000 UTF-8 bytes.' },
    preserve: { type: 'array', items: { type: 'string' }, maxItems: 40, description: 'Facts and instructions to retain verbatim or in detail.' },
    discard: { type: 'array', items: { type: 'string' }, maxItems: 40, description: 'Redundant history to summarize. Does not authorize deleting files.' },
    nextStep: { type: 'string', description: 'Exact authorized next action, including where to stop. Required even when resume is false.' },
    resume: { type: 'boolean', description: 'Explicit opt-in to ONE automatic next turn. Use false when work is complete, the user asked to stop, or the next step needs user input.' },
  }, required: ['summary', 'preserve', 'discard', 'nextStep', 'resume'] };
const toolDefinitions = [
  { name: 'probe_compaction', description: 'Read-only preflight for an extension-owned Codex VS Code chat on Windows, macOS, or Linux. Run after compaction_status and before schedule_compaction to verify the exact owner/thread, extension version, runtime layout, public schema, and IPC access. It does not compact or prove live compaction compatibility; layout_compatible means only that the required layout was found. Standalone Codex CLI sessions are unsupported because they have no VS Code extension owner. Use compaction_status instead to inspect an existing job.', inputSchema: schema,
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'schedule_compaction', description: 'Schedule ONE compaction after this answer. Only when the user authorizes compaction. Optional handoff describes what to keep/summarize and is saved exactly in a per-job file. resume:true explicitly requests ONE subsequent turn with that handoff and nextStep; use only for authorized continuation. Cancels on observed new user input or a stopped turn. Return the handoff in context before finishing. Compaction prompt itself is not overridden. Check status later; no automatic retries.',
    inputSchema: { ...schema, properties: { ...schema.properties, handoff: handoffSchema } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'compaction_status', description: 'Read-only local job inspection. Run before probe_compaction or schedule_compaction to detect an unfinished job, and after scheduling or cancellation to inspect its exact outcome and metrics. It does not probe extension compatibility. scheduled, waiting_for_idle, requesting, and accepted are intermediate; completed requires a newly observed completed contextCompaction event. resumed identifies a returned continuation turn, not successful work. Missing or stale post-compaction telemetry can skip automatic continuation with insufficient_headroom.', inputSchema: schema,
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'cancel_compaction', description: 'Cancel pending compaction or continuation dispatches only for the exact job returned by schedule_compaction or compaction_status. Already sent requests cannot be undone. Use compaction_status for observation and inspect it after cancellation.',
    inputSchema: { ...schema, properties: { ...schema.properties, jobId: { type: 'string', description: 'Exact jobId returned by schedule_compaction or compaction_status for this thread. Never infer it.' } }, required: ['threadId', 'jobId'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
];

async function serveMcp() {
  const input = readline.createInterface({ input: process.stdin });
  const rpcError = (id, code, message) => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id, error: { code, message },
  }) + '\n');
  for await (const line of input) {
    let message;
    try { message = JSON.parse(line); } catch { rpcError(null, -32700, 'Parse error'); continue; }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' ||
        typeof message.method !== 'string') {
      rpcError(null, -32600, 'Invalid Request'); continue;
    }
    if (message.id === undefined) continue;
    let result;
    try {
      switch (message.method) {
        case 'initialize':
          if (typeof message.params?.protocolVersion !== 'string') throw new Error('protocolVersion is required');
          result = { protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} }, serverInfo: { name: 'rekall', version: '0.3.1' } }; break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: toolDefinitions }; break;
        case 'tools/call': {
          const args = message.params.arguments ?? {};
          const threadId = validateThreadId(args.threadId);
          const name = message.params.name;
          let value;
          if (name === 'probe_compaction') value = await probe(threadId);
          else if (name === 'schedule_compaction') value = await schedule(threadId, args.handoff);
          else if (name === 'compaction_status') value = readStatus(threadId);
          else if (name === 'cancel_compaction') value = cancel(threadId, args.jobId);
          else throw new Error('Unknown tool');
          result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
          break;
        }
        default:
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
            error: { code: -32601, message: 'Method not found' } }) + '\n');
          continue;
      }
    } catch (error) {
      if (message.method !== 'tools/call') {
        rpcError(message.id, -32602, error.message); continue;
      }
      result = { isError: true, content: [{ type: 'text', text: error.message }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    const [command, argument, jobId] = process.argv.slice(2);
    const threadId = argument ?? process.env.CODEX_THREAD_ID;
    if (command === 'mcp') await serveMcp();
    else if (command === 'worker') await worker(validateThreadId(threadId), jobId);
    else if (command === 'probe') console.log(JSON.stringify(await probe(threadId), null, 2));
    else if (command === 'schedule') console.log(JSON.stringify(await schedule(threadId), null, 2));
    else if (command === 'schedule-with-handoff') console.log(JSON.stringify(await schedule(jobId ?? process.env.CODEX_THREAD_ID,
      JSON.parse(fs.readFileSync(argument, 'utf8'))), null, 2));
    else if (command === 'cancel') console.log(JSON.stringify(cancel(threadId, jobId), null, 2));
    else if (command === 'status') console.log(JSON.stringify(readStatus(validateThreadId(threadId)), null, 2));
    else throw new Error('Usage: node bridge.mjs probe|schedule|status [threadId], schedule-with-handoff file [threadId], cancel threadId jobId, or mcp');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
