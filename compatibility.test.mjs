import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRuntimeCompatibility, inspectPublicSchema, findCodexBinary } from './compatibility.mjs';

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
