import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

// The public item schema has no completion flag. This is the extension's
// projection of item/started and item/completed, checked separately below.
export function inspectRuntimeCompatibility(state) {
  if (!state || typeof state.threadRuntimeStatus?.type !== 'string' ||
      !Array.isArray(state.requests) || !Array.isArray(state.turns)) {
    throw new Error('Unsupported extension state layout; run probe_compaction after checking extension compatibility');
  }
  let observedCompactionItems = 0;
  // Reloaded public history drops the private completion flag. It is not a
  // live completion signal and must never authorize continuation by itself.
  const historicalItems = new Set();
  walk(state.turnHistory?.history, item => {
    if (item.type === 'contextCompaction') historicalItems.add(item);
  });
  const inspect = item => {
    if (item.type !== 'contextCompaction') return;
    if (typeof item.id !== 'string' || !item.id ||
        (typeof item.completed !== 'boolean' && !(historicalItems.has(item) && !Object.hasOwn(item, 'completed')))) {
      throw new Error('Unsupported contextCompaction lifecycle: the internal extension item must have id and boolean completed');
    }
    if (typeof item.completed === 'boolean') observedCompactionItems++;
  };
  walk(state.turns, inspect);
  walk(state.turnHistory, inspect);
  return { status: observedCompactionItems ? 'compatible' : 'layout_compatible', completionField: 'completed', observedCompactionItems,
    completionFieldObserved: observedCompactionItems > 0 };
}

const hasTag = (schema, key, value) => schema?.properties?.[key]?.const === value ||
  schema?.properties?.[key]?.enum?.includes(value);
const required = (schema, key) => schema?.required?.includes(key);
const resolve = (root, schema) => schema?.$ref?.startsWith('#/')
  ? schema.$ref.slice(2).split('/').reduce((node, key) => node?.[key], root) : schema;

export function inspectPublicSchema(requests, notifications) {
  let compact = false;
  walk(requests, item => {
    if (!hasTag(item, 'method', 'thread/compact/start')) return;
    const params = resolve(requests, item.properties.params);
    compact = required(params, 'threadId') && params.properties?.threadId?.type === 'string' &&
      params.required.every(key => key === 'threadId');
  });
  for (const method of ['item/started', 'item/completed']) {
    let found = false;
    walk(notifications, item => {
      if (!hasTag(item, 'method', method)) return;
      const params = resolve(notifications, item.properties.params);
      if (!['threadId', 'turnId', 'item'].every(key => required(params, key))) return;
      const union = resolve(notifications, params.properties.item);
      walk(union, variant => {
        if (hasTag(variant, 'type', 'contextCompaction') && required(variant, 'id') &&
            variant.properties.id.type === 'string') found = true;
      });
    });
    if (!found) throw new Error(`Unsupported public App Server schema: missing ${method} contextCompaction lifecycle`);
  }
  if (!compact) throw new Error('Unsupported public App Server schema: thread/compact/start requires a different request');
  return { status: 'compatible', lifecycle: ['item/started', 'item/completed'],
    internalCompletionFlagIsPublic: false };
}

export function findCodexBinary(env = process.env, { platform = process.platform, existsSync = fs.existsSync } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const executable = platform === 'win32' ? 'codex.exe' : 'codex';
  if (env.REKALL_CODEX_BINARY) {
    if (!paths.isAbsolute(env.REKALL_CODEX_BINARY) || !existsSync(env.REKALL_CODEX_BINARY)) {
      throw new Error('REKALL_CODEX_BINARY must be an absolute path to the extension-bundled Codex executable');
    }
    return env.REKALL_CODEX_BINARY;
  }
  // Prefer the binary injected by the owning VS Code extension, never a
  // different npm CLI that happens to be first on PATH.
  const envPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const candidates = [...new Set(envPath.split(paths.delimiter).filter(entry =>
    paths.isAbsolute(entry) && /[/\\]openai\.chatgpt-[^/\\]+[/\\]bin[/\\][^/\\]+[/\\]?$/i.test(entry))
    .map(entry => paths.join(entry, executable)))].filter(file => existsSync(file));
  if (candidates.length !== 1) throw new Error('Cannot identify one extension-bundled Codex binary; set REKALL_CODEX_BINARY to its absolute path');
  return candidates[0];
}

export async function probeCompatibility(state, options = {}) {
  const env = options.env ?? process.env;
  const executeFile = options.execute ?? execute;
  const readFile = options.readFileSync ?? fs.readFileSync;
  const makeTemporaryDirectory = options.mkdtempSync ?? fs.mkdtempSync;
  const removeDirectory = options.rmSync ?? fs.rmSync;
  const runtime = inspectRuntimeCompatibility(state);
  if (env.REKALL_PIPE || env.CONTEXT_COMPACT_PIPE) {
    return { runtime, publicSchema: { status: 'not_checked', reason: 'custom_test_transport' } };
  }
  const binary = options.binary ?? findCodexBinary(env);
  const extensionRoot = path.resolve(path.dirname(binary), '..', '..');
  const manifest = JSON.parse(readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
  if (manifest.publisher !== 'openai' || manifest.name !== 'chatgpt') {
    throw new Error(`Unexpected extension identity ${manifest.publisher ?? 'unknown'}.${manifest.name ?? 'unknown'}; expected openai.chatgpt`);
  }
  const temporary = makeTemporaryDirectory(path.join(os.tmpdir(), 'rekall-schema-'));
  try {
    // This exports schemas and exits; it does not start another App Server.
    await executeFile(binary, ['app-server', 'generate-json-schema', '--out', temporary], {
      windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
    });
    const read = file => JSON.parse(readFile(path.join(temporary, file), 'utf8'));
    return { extensionVersion: manifest.version ?? 'unknown', runtime,
      publicSchema: inspectPublicSchema(read('ClientRequest.json'), read('ServerNotification.json')) };
  } finally {
    // Delete only the exact private temporary directory created above.
    if (path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('rekall-schema-')) {
      removeDirectory(temporary, { recursive: true, force: true });
    }
  }
}
