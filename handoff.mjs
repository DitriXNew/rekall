import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');

export function validateHandoff(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('handoff must be an object');
  const allowed = ['summary', 'preserve', 'discard', 'nextStep', 'resume'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown handoff field');
  if (typeof value.summary !== 'string' || !value.summary.trim()) throw new Error('handoff.summary is required');
  for (const key of ['preserve', 'discard']) {
    if (!Array.isArray(value[key]) || value[key].length > 40 || value[key].some(x => typeof x !== 'string' || !x.trim())) {
      throw new Error(`handoff.${key} must be an array of at most 40 nonempty strings`);
    }
  }
  if (typeof value.resume !== 'boolean') throw new Error('handoff.resume must be explicitly true or false');
  if (typeof value.nextStep !== 'string' || (value.resume && !value.nextStep.trim())) throw new Error('A nextStep is required for automatic continuation');
  if (Buffer.byteLength(JSON.stringify(value)) > 32000) throw new Error('handoff exceeds 32000 UTF-8 bytes');
  return { summary: value.summary, preserve: [...value.preserve], discard: [...value.discard], nextStep: value.nextStep, resume: value.resume };
}

export function historyTurns(state) {
  const history = state?.turnHistory?.history;
  const canonical = state?.turnHistory?.kind === 'canonical' && history
    ? history.islands.flatMap(island => island.entries.map(entry => history.entitiesByKey[entry.value]).filter(Boolean)) : [];
  return [...canonical, ...(state?.turns ?? [])];
}

// Fingerprint the latest user-bearing turn, including mid-turn steering.
// Never persist the text or scan unrelated conversations. Pagination of older
// history must not cancel a job; changes to the current input must cancel it.
export function userBoundary(state) {
  const turns = historyTurns(state).filter(turn => turn.params?.input?.length || turn.items?.some(item => item.type === 'userMessage'));
  const latest = turns.reduce((last, turn) => !last || (turn.turnStartedAtMs ?? 0) >= (last.turnStartedAtMs ?? 0) ? turn : last, null);
  if (!latest) return { fingerprint: digest('no-user-input'), interrupted: false };
  const messages = (latest.items ?? []).filter(item => item.type === 'userMessage').map(item => ({ id: item.id, content: item.content }));
  return { fingerprint: digest(JSON.stringify({ id: latest.turnId ?? latest.params?.clientUserMessageId ?? latest.turnStartedAtMs,
    input: latest.params?.input, messages })), interrupted: latest.status === 'interrupted' || latest.status === 'failed' };
}

export function continuationText(record, checkpointPath) {
  return `[Automatic continuation requested through Rekall; job ${record.jobId}]\n` +
    `Context compaction has completed. This message resumes only the previously authorized task.\n` +
    `Read the saved handoff at ${checkpointPath}. Its exact contents are also included below.\n` +
    `Follow the latest user instructions and all existing permission boundaries. A stop instruction takes precedence.\n` +
    `Continue with nextStep only. Do not schedule another compaction or continuation merely because of this message.\n` +
    `The discard list concerns redundant context, not deleting files or ignoring constraints.\n\n` + JSON.stringify(record.handoff, null, 2);
}
