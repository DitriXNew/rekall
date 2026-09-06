# Rekall contributor instructions

Read [README.md](README.md) before changing the project. Rekall is a local MCP server that asks the owning Codex VS Code extension to compact the current thread, persists a verified handoff, and optionally starts one continuation.

## Source and tests

- `bridge.mjs`: MCP server, CLI, worker, state journal, and dispatch policy.
- `compatibility.mjs`: public-schema and internal completion-signal preflight.
- `ipc.mjs`: Codex VS Code extension IPC client.
- `handoff.mjs`: handoff validation and continuation boundary.
- `bridge.test.mjs`: isolated protocol and subprocess tests.
- Run `npm test` (or `node --test`) from the repository root. Use Node's test discovery so the command also works on Windows with Node 20.
- Tests must use their dedicated pipe and temporary job directories. Never aim tests at an active Codex thread.

Node.js 20 or newer is required. Windows and macOS ARM have full live compaction/continuation verification with the extension versions named in the README. The maintainer reports successful Linux testing without recorded platform details or measurements; Intel Mac live verification remains outstanding. CI on Windows, macOS, and Linux verifies the isolated implementation, not live extension compatibility. Linux IPC uses the same private per-user socket checks as macOS; preserve the distinction between measured verification and maintainer-reported testing.

Rekall works only with chats owned by the Codex VS Code extension. Standalone Codex CLI sessions, the Codex desktop app, and Claude Code are unsupported because this adapter uses the extension's IPC owner and lifecycle events. CLI-based plugin installation does not establish support for CLI-owned sessions.

## Invariants

- Preserve the distinction between an accepted request and an observed, completed compaction.
- Verify the current owner and exact thread. Never infer a thread from history.
- Require stable idle state and cancel pending dispatch on observed new user input, stopped turns, or failed turns.
- Apply the 60% headroom guard only after completed compaction and only to automatic continuation. Never use it to block scheduling.
- Keep token measurements and outcomes scoped per thread and job.
- Never retry automatically after failure, timeout, or an unknown outcome.
- Never override the thread's permissions or global Codex configuration.
- Treat extension IPC as internal and re-check compatibility after updates.
- `REKALL_ALLOW_UNVERIFIED=1` overrides only the extension version gate. Keep its probe warning and all identity, schema, runtime, and IPC checks. Never enable it automatically after a failed probe.
- Keep `REKALL_CODEX_BINARY` absolute when explicitly configured. A test-only
  `REKALL_PIPE` transport skips the public-schema subprocess by design.

## Using Rekall as an agent

Use Rekall when the user asks for compaction, or after a substantial completed stage of a long task when accumulated history is no longer useful. Finish and verify the current stage first. Do not compact after routine answers or small edits.

Obtain the exact `CODEX_THREAD_ID` from the current environment. Read `compaction_status`, then run `probe_compaction`. Do not queue a second active job. Prepare a handoff with `summary`, `preserve`, `discard`, `nextStep`, and an explicit `resume` boolean. Keep the handoff below 32,000 UTF-8 bytes and exclude secrets.

Use `resume: true` only for specific remaining work already authorized by the user, and give `nextStep` a clear stopping condition. Use `resume: false` when the task is complete, the user asked to stop, or progress depends on their answer. An automatic continuation never authorizes another compaction or a new task.

After compaction, resume only with fresh telemetry showing context use at or below 60%. Above that boundary, or with missing or stale telemetry, preserve the completed result and record `resumeSkipped: "insufficient_headroom"`.

After `schedule_compaction`, report the queued status and end the response. The worker needs the thread to become idle, so do not wait for completion during the same active turn. In a continuation, read the handoff path from the message, verify the job and compaction status, apply newer user instructions, and perform only `nextStep`. Do not automatically repeat a failed, cancelled, timed-out, or unknown attempt.

## Repository hygiene

Never commit or publish handoffs, journals, lock files, configuration backups, environment files, or real thread identifiers. Use synthetic fixtures. Preserve the package `files` allowlist and check `npm pack --dry-run` when package contents change.
