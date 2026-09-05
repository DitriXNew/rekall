import test from 'node:test';
import assert from 'node:assert/strict';

import { applyPatches, CodexIpc } from './ipc.mjs';
import { continuationText } from './handoff.mjs';

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
