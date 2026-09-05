# Rekall

Rekall gives Codex a deliberate context-compaction checkpoint. An agent records a handoff, waits for its current turn to become idle, asks the owning Codex VS Code extension to run native compaction, and can resume the authorized task exactly once with the verified handoff.

**102,826 → 10,537 context tokens (89.8% reduction), followed by automatic continuation in 0.908 seconds.** This release was verified in a live Codex thread: compaction took 87.5 seconds, and the resumed agent read the saved handoff. See the [sanitized verification record](live-verification.json).

A separate historical run reported 91,384 → 10,798 tokens (88.2% reduction), about two minutes of compaction, and a 0.9-second continuation delay. These are individual context-token measurements, not a latency distribution or a guarantee of reclaimed model-window capacity. The 15-minute worker deadline has not been validated against a representative workload distribution.

## Requirements and support

- Node.js 20 or newer
- Windows
- The Codex VS Code extension

Live IPC has been verified only on Windows with `openai.chatgpt-26.901.22334-win32-x64`. Rekall uses an internal extension IPC protocol, which is not a stable public API. Run `probe_compaction` after any extension update. Rekall rejects an unverified extension version until its adapter is validated. Linux CI exercises the isolated protocol and process tests; it does not establish live Linux support.

Compatibility checks compare the public App Server schema with the internal completion signal Rekall observes. Before the thread has exposed a compaction item, the probe reports `layout_compatible`: the public lifecycle and state layout are compatible, while the private completion field has not yet been observed. Rekall locates a unique extension-bundled executable automatically; when that is not possible, set `REKALL_CODEX_BINARY` to its absolute path. Test transports using `REKALL_PIPE` deliberately skip the schema subprocess.

## Install

Clone the public repository and install its locked dependencies:

```powershell
git clone https://github.com/DitriXNew/rekall.git
Set-Location rekall
npm ci
```

The repository is a Codex plugin (`.codex-plugin/plugin.json`) and includes its MCP declaration in `.mcp.json`. `${PLUGIN_ROOT}` in that declaration is resolved by Codex to the installed plugin directory. To register the server manually from the cloned repository, run:

```powershell
codex mcp add rekall -- node "$PWD/bridge.mjs" mcp
```

Start a new Codex session after installing or changing the plugin so its skill and MCP tools are discovered. Manual MCP registration adds only the server. To also use the bundled skill with a manual installation, copy `skills/rekall` into `$CODEX_HOME/skills/rekall` (by default, `~/.codex/skills/rekall`) before starting the new session.

You can also run the CLI directly:

```powershell
node ./bridge.mjs probe
node ./bridge.mjs status
node ./bridge.mjs schedule
```

These commands read the current `CODEX_THREAD_ID`. Outside a Codex session, pass the exact known thread ID as the final argument. Rekall never guesses a thread or chooses the most recently updated conversation.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `probe_compaction(threadId)` | Read-only compatibility, owner, and thread-state check. |
| `schedule_compaction(threadId, handoff?)` | Queue one compaction after the current response becomes idle. |
| `compaction_status(threadId)` | Read the current job and recorded metrics. |
| `cancel_compaction(threadId, jobId)` | Cancel a dispatch that has not already been sent. |

Call `compaction_status` and `probe_compaction` before scheduling. Rekall does not impose a context-use threshold on a user-requested compaction.

## Handoffs and continuation

An optional handoff has this shape:

```json
{
  "summary": "The refactor is complete and its tests pass; release review remains.",
  "preserve": ["User constraints", "Changed files and test results"],
  "discard": ["Repeated command output", "Superseded investigation notes"],
  "nextStep": "Review the package contents, report the result, and stop.",
  "resume": true
}
```

The complete handoff is limited to 32,000 UTF-8 bytes and each list to 40 entries. `discard` identifies conversation history that may be summarized; it never authorizes file deletion. The handoff is stored separately, bound to the thread and job, and checked by SHA-256 before continuation.

Set `resume` explicitly. When it is `true`, `nextStep` must identify concrete work that the user has already authorized and include a stopping condition. When the task is finished, the user asked to stop, or further work needs an answer, set `resume` to `false`.

After compaction, automatic continuation requires fresh telemetry showing no more than 60% of the context window in use. Above 60%, or when telemetry is missing or stale, Rekall keeps the compaction result but skips continuation with `resumeSkipped: "insufficient_headroom"`. This guard limits automatic follow-up only; it never blocks compaction itself.

Scheduling does not mean compaction completed. `scheduled`, `waiting_for_idle`, `requesting`, and `accepted` are intermediate states. `completed` requires a newly observed completed compaction record. `resumed` means the owner returned a follow-up turn ID; it does not mean that turn's work succeeded. Rekall records the compaction ID, completion time, resume turn ID, and up to 20 per-thread measurements, including job number, compaction duration, resume delay, reclaimed tokens, and reclaimed fraction.

Before dispatch, Rekall requires stable idle state, no pending permission request, and no unconfirmed submission. New user input or a stopped or failed turn cancels a pending dispatch. A request already sent cannot be recalled. The worker deadline is 15 minutes from worker start, including time spent waiting for the current response to finish. Timeouts and unknown outcomes are terminal and are never retried automatically.

For a handoff from the CLI, write the JSON object to a UTF-8 file outside the repository and pass its absolute path:

```powershell
node ./bridge.mjs schedule-with-handoff "C:\full\path\to\handoff.json"
node ./bridge.mjs cancel $env:CODEX_THREAD_ID <job-id>
```

## Data and privacy

Rekall does not export the transcript. It keeps the active thread snapshot in memory while processing state updates. Local `jobs/` files contain thread and job identifiers, timestamps, state, errors, token counts, paths, checksums, and the handoff text the user explicitly asked it to preserve. These files are excluded from Git and npm packages. Do not publish them or include them in bug reports.

Jobs default to `$CODEX_HOME/tools/rekall/jobs`, or `~/.codex/tools/rekall/jobs` when `CODEX_HOME` is unset. Current environment variables use the `REKALL_` prefix. Legacy `CONTEXT_COMPACT_*` names remain aliases, and an existing `$CODEX_HOME/tools/context-compact/jobs` directory is reused so active locks and history are not lost during migration. `REKALL_JOBS_DIR` can select a different local journal directory for isolated use.

The extension's compaction request does not accept custom instructions. `preserve` and `discard` guide the resumed model; they do not override the native compaction prompt or guarantee selective retention. Rekall does not change global Codex permissions or configuration.

## Development

Run the full test suite:

```powershell
npm test
```

The tests use a dedicated named pipe, temporary job directories, and child processes. They must never target a live conversation. This revision passed all 32 tests on Windows with Node.js 20.20.2 and 24.6.0. CI is configured for Windows and Linux with Node.js 20 and 22; that matrix has not yet been run for this revision. Local Linux verification was unavailable because the installed WSL distribution could not start. Live extension IPC support remains Windows-only.

Inspect the exact npm payload before publishing:

```powershell
npm pack --dry-run
```

This project is licensed under the [MIT License](LICENSE).

## Uninstall

Remove a manual MCP registration with:

```powershell
codex mcp remove rekall
```

A worker that has already started continues until it records a result or reaches its deadline. Inspect its journal before handling a stale lock; never remove a lock while its recorded process is still running.

## References

- [Codex App Server: trigger thread compaction](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Issue #33398](https://github.com/openai/codex/issues/33398)
- [Issue #25074](https://github.com/openai/codex/issues/25074)
