import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

// Private VS Code Codex IPC, verified against openai.chatgpt 26.901.22334.
// Discovery, read-only following, compaction, and explicit one-shot continuation.
export function resolveIpcEndpoint({ platform = process.platform, env = process.env,
  homedir = os.homedir, getuid = process.getuid, lstatSync = fs.lstatSync } = {}) {
  if (platform === 'win32') return '\\\\.\\pipe\\codex-ipc';
  if (platform !== 'darwin') throw new Error(`Live Codex IPC is unsupported on ${platform}; use Windows or macOS`);
  const home = env.CODEX_HOME ?? path.posix.join(homedir(), '.codex');
  if (!path.posix.isAbsolute(home)) throw new Error('CODEX_HOME must be absolute for macOS IPC');
  const directory = path.posix.join(home, 'ipc');
  const endpoint = path.posix.join(directory, 'ipc.sock');
  const uid = getuid?.();
  if (!Number.isInteger(uid) || uid < 0) throw new Error('Cannot verify the current macOS user for IPC');
  // Match the extension's private directory (0700) and socket (0600).
  // lstat rejects symlinks; never create, chmod, or fall back to a shared socket.
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) {
    throw new Error('Codex IPC directory must be private and owned by the current user');
  }
  const socket = lstatSync(endpoint);
  if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077) !== 0) {
    throw new Error('Codex IPC socket must be private and owned by the current user');
  }
  return endpoint;
}

export class CodexIpc extends EventEmitter {
  constructor(threadId, { endpoint } = {}) {
    super();
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new Error('Invalid thread ID');
    this.threadId = threadId;
    this.endpoint = endpoint;
    this.clientId = 'initializing-client';
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.state = null;
    this.revision = null;
  }

  async connect() {
    // Resolve on every connection so detached workers also validate the socket.
    this.socket = net.connect(this.endpoint ?? resolveIpcEndpoint());
    this.socket.on('data', data => {
      try { this.receive(data); } catch (error) { this.fail(error); }
    });
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('IPC connection closed')));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IPC connection timeout')), 5000);
      this.socket.once('connect', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const init = await this.request('initialize', { clientType: 'codex-rekall' }, 0);
    this.clientId = init.result.clientId;
    const owner = await this.request('thread-owner-discovery', {
      hostId: 'local', conversationId: this.threadId,
    }, 1);
    this.ownerId = owner.handledByClientId;
    if (!this.ownerId) throw new Error('Current thread owner was not found');
    return this;
  }

  write(message) {
    const body = Buffer.from(JSON.stringify(message));
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length);
    body.copy(frame, 4);
    this.socket.write(frame);
  }

  request(method, params, version, targeted = false) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${method}: response timeout; outcome may be unknown`));
      }, 15000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.write({ type: 'request', requestId, sourceClientId: this.clientId,
        method, params, version, timeoutMs: 10000,
        ...(targeted ? { hostId: 'local', targetClientId: this.ownerId } : {}),
      });
    });
  }

  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE();
      if (length === 0 || length > 256 * 1024 * 1024) throw new Error('Invalid IPC frame length');
      if (this.buffer.length < length + 4) return;
      const message = JSON.parse(this.buffer.subarray(4, length + 4));
      this.buffer = this.buffer.subarray(length + 4);
      if (message.type === 'response') {
        const pending = this.pending.get(message.requestId);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        if (message.resultType === 'success') pending.resolve(message);
        else pending.reject(new Error(message.error || 'IPC request failed'));
      } else if (message.type === 'client-discovery-request') {
        this.write({ type: 'client-discovery-response', requestId: message.requestId,
          response: { canHandle: false } });
      } else if (message.type === 'broadcast') {
        this.receiveBroadcast(message);
      }
    }
  }

  receiveBroadcast(message) {
    const params = message.params;
    if (message.method !== 'thread-stream-state-changed' || message.version !== 11 ||
        message.sourceClientId !== this.ownerId || params?.hostId !== 'local' ||
        params.conversationId !== this.threadId) return;
    const change = params.change;
    if (change?.type === 'snapshot') {
      this.state = change.conversationState;
    } else if (change?.type === 'patches' && this.state && change.baseRevision === this.revision) {
      this.state = applyPatches(this.state, change.patches);
    } else {
      this.state = null;
      this.revision = null;
      this.follow();
      return;
    }
    this.revision = change.revision;
    this.emit('state', this.state);
  }

  follow() {
    this.write({ type: 'broadcast', sourceClientId: this.clientId,
      targetClientIds: [this.ownerId], version: 1,
      method: 'thread-stream-following-changed', params: {
        hostId: 'local', conversationId: this.threadId, following: true,
      } });
  }

  async snapshot() {
    if (this.state) return this.state;
    return new Promise((resolve, reject) => {
      const onState = state => { clearTimeout(timer); resolve(state); };
      const timer = setTimeout(() => {
        this.off('state', onState);
        reject(new Error('Thread snapshot timeout'));
      }, 12000);
      this.once('state', onState);
      this.follow();
    });
  }

  async compact() {
    const response = await this.request('thread-follower-compact-thread', { conversationId: this.threadId }, 2, true);
    if (response.result?.ok !== true) throw new Error('Compaction acknowledgment was not recognized');
    return response;
  }

  async startTurn(text, clientUserMessageId) {
    const response = await this.request('thread-follower-start-turn', {
      conversationId: this.threadId,
      turnStart: { request: { threadId: this.threadId, clientUserMessageId,
        input: [{ type: 'text', text, text_elements: [] }] }, context: { inheritThreadSettings: true } },
    }, 3, true);
    const turn = response.result?.result?.turn;
    if (!turn?.id || !['inProgress', 'completed'].includes(turn.status)) {
      throw new Error('Continuation did not return a started turn; outcome may be unknown');
    }
    return turn;
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('connectionFailure', error);
    this.socket?.destroy();
  }

  close() { this.socket?.destroy(); }
}

export function applyPatches(state, patches) {
  if (!Array.isArray(patches)) throw new Error('State patches must be an array');
  for (const patch of patches) {
    const keys = patch.path;
    if (!Array.isArray(keys) || keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) {
      throw new Error('Invalid state patch path');
    }
    if (!['add', 'replace', 'remove'].includes(patch.op)) throw new Error('Unsupported state patch');
    if (keys.length === 0) { state = patch.value; continue; }
    let target = state;
    for (const key of keys.slice(0, -1)) {
      if (target == null || !Object.hasOwn(target, key)) throw new Error('State patch does not match snapshot');
      target = target[key];
    }
    const key = keys.at(-1);
    if (Array.isArray(target)) {
      const index = key === '-' && patch.op === 'add' ? target.length :
        typeof key === 'number' && Number.isSafeInteger(key) ? key :
          typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : NaN;
      const maximum = patch.op === 'add' ? target.length : target.length - 1;
      if (!Number.isSafeInteger(index) || index < 0 || index > maximum) {
        throw new Error('Invalid state patch array index');
      }
      if (patch.op === 'remove') target.splice(index, 1);
      else if (patch.op === 'add') target.splice(index, 0, patch.value);
      else target[index] = patch.value;
      continue;
    }
    if (target == null || typeof target !== 'object') throw new Error('State patch target is not an object');
    if ((patch.op === 'replace' || patch.op === 'remove') && !Object.hasOwn(target, key)) {
      throw new Error('State patch does not match snapshot');
    }
    if (patch.op === 'remove') {
      delete target[key];
    } else target[key] = patch.value;
  }
  return state;
}
