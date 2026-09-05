---
name: rekall
description: Compact the current Codex thread through Rekall with a verified handoff and optional one-time continuation. Use when the user asks to compact context or after a substantial completed stage of an ongoing long task; do not use for routine turns.
---

# Rekall

Use Rekall only for the current thread. Obtain `CODEX_THREAD_ID` from the environment; never guess an identifier or select a thread from history.

Before scheduling, finish and verify the current stage. Call `compaction_status` to ensure there is no unfinished job, then call `probe_compaction` to verify the owner, IPC compatibility, and thread state. Rekall has no context-use threshold for scheduling a user-requested compaction.

Create a handoff containing:

- `summary`: the task, constraints, decisions, completed work, validation, and work that remains.
- `preserve`: facts and instructions that need detailed retention.
- `discard`: repeated or obsolete conversation history that may be summarized. This never authorizes deleting files.
- `nextStep`: the exact already-authorized continuation and where it must stop.
- `resume`: an explicit boolean.

Keep it below 32,000 UTF-8 bytes, with no more than 40 entries in either list, and exclude secrets. Use `resume: true` only when concrete work remains within the user's existing authorization. Use `resume: false` when the task is done, the user asked to stop, or further work needs their response.

Call `schedule_compaction` once. Report the returned queued status and end the current response so the worker can observe idle state. Do not wait for completion in that same turn, and do not describe `scheduled`, `requesting`, or `accepted` as completed.

Automatic continuation is separately guarded after compaction. It proceeds only when fresh telemetry reports context use at or below 60%. When use is higher or telemetry is missing or stale, treat compaction as completed and continuation as skipped with `resumeSkipped: "insufficient_headroom"`.

On an automatic continuation, read the referenced handoff, verify the exact job with `compaction_status`, honor any newer user instruction, perform only `nextStep`, and stop at its stated boundary. Never schedule another compaction merely because the continuation occurred. Do not retry a failed, cancelled, timed-out, or unknown outcome automatically.
