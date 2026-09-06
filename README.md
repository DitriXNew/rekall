# Rekall

[CI: Windows + Linux, Node.js 20 + 22](https://github.com/DitriXNew/rekall/actions/workflows/ci.yml?query=branch%3Amaster)

[HOL Plugin Scanner](https://github.com/DitriXNew/rekall/actions/workflows/hol-plugin-scanner.yml?query=branch%3Amaster)

Long Codex tasks accumulate logs, research, and intermediate decisions. Rekall lets the agent clear that accumulated context at a useful checkpoint while keeping a written handoff of the task, constraints, and next step.

The agent saves the handoff, finishes its turn, and asks the Codex VS Code extension to compact the conversation. Rekall can then resume the authorized work once, carrying the verified handoff into the next turn.

## Install

Requires Windows, Node.js 20 or newer on PATH, the Codex VS Code extension, and a Codex CLI with the `plugin` commands.

```powershell
codex plugin marketplace add DitriXNew/rekall
codex plugin add rekall@rekall
```

This installs the MCP server and the bundled skill together. Start a new chat in the Codex VS Code extension, then ask:

> Compact this thread with a handoff, then continue the remaining work once.

To check access without compacting, ask Codex to run `probe_compaction` for the current thread. The repository includes its [marketplace entry](.agents/plugins/marketplace.json), plugin manifest, and MCP declaration; Codex resolves `${PLUGIN_ROOT}` to the installed plugin directory.

<details>
<summary>Or install manually</summary>

Clone the repository and register the MCP server with an absolute path:

```powershell
git clone https://github.com/DitriXNew/rekall.git
Set-Location rekall
npm ci
codex mcp add rekall -- node "$PWD/bridge.mjs" mcp
```

Manual MCP registration installs only the server. Copy `skills/rekall` into `$CODEX_HOME/skills/rekall` (default: `~/.codex/skills/rekall`) to install the skill, then start a new extension chat.

If migrating an existing manual installation to the plugin, remove the old manual MCP registration and the manually copied skill to avoid duplicate tool/skill discovery. The retired server name was `context-compact`; current manual installations use `rekall`. Keep the job directory so existing jobs and locks remain available.

</details>

## Measured results

**Observed context-token reductions: 78–90%, with automatic continuation about one second after compaction.**

| Run | Context tokens before → after | Reduction | Compaction | Continuation delay |
| --- | ---: | ---: | ---: | ---: |
| Release verification | 102,826 → 10,537 | 89.8% | 87.5 s | 0.908 s |
| Installed-package verification | 55,856 → 12,128 | 78.3% | 88.5 s | 1.065 s |
| Earlier user-reported run | 91,384 → 10,798 | 88.2% | ~2 min | ~0.9 s |

The resumed agent read the saved handoff in both verification runs. See the [sanitized verification record](live-verification.json). Measurement limits and compatibility details are below.

## Scope

Rekall operates on chats owned by the **Codex VS Code extension on Windows**. Standalone Codex CLI sessions, the Codex desktop app, and Claude Code are not supported. The CLI commands below are another way to address an extension-owned chat; they do not add support for standalone CLI conversations. Node.js is required; there is no standalone executable.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `probe_compaction(threadId)` | Read-only compatibility, owner, and thread-state check. |
| `schedule_compaction(threadId, handoff?)` | Queue one compaction after the current response becomes idle. |
| `compaction_status(threadId)` | Read the current job and recorded metrics. |
| `cancel_compaction(threadId, jobId)` | Cancel a dispatch that has not already been sent. |

Read `compaction_status` and `probe_compaction` before scheduling. Use only the exact current `CODEX_THREAD_ID`, and do not queue a second unfinished job. Rekall does not impose a context-use threshold on a user-requested compaction.

## CLI reference

Run these commands from the repository or installed package directory:

| Command | Purpose |
| --- | --- |
| `node ./bridge.mjs probe [threadId]` | Check the current owner, state, and compatibility. |
| `node ./bridge.mjs status [threadId]` | Read the current job's status. |
| `node ./bridge.mjs schedule [threadId]` | Compact without automatic continuation. |
| `node ./bridge.mjs schedule-with-handoff <absolute-handoff-json-path> [threadId]` | Compact with the saved handoff and its explicit resume setting. |
| `node ./bridge.mjs cancel <threadId> <jobId>` | Cancel pending dispatches for the exact job. |
| `node ./bridge.mjs mcp` | Run the MCP stdio server. |

Square brackets denote an optional argument, not literal command text. Commands with an optional `threadId` use `CODEX_THREAD_ID` when it is omitted. `cancel` requires both IDs explicitly; copy `jobId` from status. Outside the extension session, pass its exact known thread ID. Rekall never guesses a thread or chooses the most recently updated conversation. `worker` is an internal subprocess entry point, not a command to launch manually.

Write handoff JSON as UTF-8 **outside the repository** and quote its absolute path. Its format is described next.

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

Set `resume` explicitly. When it is `true`, `nextStep` must identify concrete work the user has already authorized and include a stopping condition. When the task is finished, the user asked to stop, or further work needs an answer, set `resume` to `false`. An automatic continuation does not authorize another compaction.

After scheduling, finish the current response: the worker waits for idle. Do not wait for compaction within that same active turn. On continuation, read the saved handoff, verify the exact job and its result, and perform only the authorized next step.

Automatic continuation requires fresh telemetry showing reduced context tokens and no more than 60% of the context window in use. Otherwise, including when telemetry is missing or stale, Rekall preserves the compaction result and skips continuation with `resumeSkipped: "insufficient_headroom"`. It rechecks this immediately before resuming. This guard limits automatic continuation; it never blocks compaction itself.

Scheduling does not mean compaction completed. `scheduled`, `waiting_for_idle`, `requesting`, and `accepted` are intermediate states. `completed` requires a newly observed completed compaction record. `resumed` means the owner returned a follow-up turn ID; it does not mean that turn's work succeeded. Rekall records the compaction ID, completion time, resume turn ID, and up to 20 per-thread measurements, including job number, compaction duration, resume delay, reclaimed tokens, and reclaimed fraction.

Before dispatch, Rekall requires stable idle state, no pending permission request, and no unconfirmed submission. New user input or a stopped or failed turn cancels a pending dispatch. A request already sent cannot be recalled. The worker deadline is 15 minutes from worker start, including idle waiting. Timeouts and unknown outcomes are terminal and are never retried automatically.

## Compatibility and extension updates

Live IPC has been verified with `openai.chatgpt-26.901.22334-win32-x64`. Rekall uses an internal extension IPC protocol, which is not a stable public API. Run `probe_compaction` after extension updates.

By default, Rekall rejects an unverified extension version. For deliberate compatibility investigation, set **`REKALL_ALLOW_UNVERIFIED=1`** in the Rekall process's environment. For a CLI probe in PowerShell:

```powershell
$env:REKALL_ALLOW_UNVERIFIED = '1'
node ./bridge.mjs probe
Remove-Item Env:REKALL_ALLOW_UNVERIFIED
```

For MCP, set the variable in the server's launch environment and restart the MCP server. Changing a terminal's environment does not affect an already running server. Only the exact value `1` enables the override.

> **Warning:** An override is not evidence of compatibility. A successful probe reports `compatibility.versionVerification.status: "unverified_override"` and a `UNVERIFIED_EXTENSION_VERSION_OVERRIDE` entry in `compatibility.warnings`. The version gate is the only check bypassed; extension identity, public schema, runtime layout, owner/thread checks, and IPC protocol checks still apply.

Report new versions through the [compatibility issue template](https://github.com/DitriXNew/rekall/issues/new?template=new-extension-version.yml), including the extension version and **redacted** probe output or error. You can report a blocked probe without enabling the override or attempting compaction.

Compatibility checks compare the public App Server schema with the internal completion signal Rekall observes. Before a thread exposes a compaction item, the probe reports `layout_compatible`: the public lifecycle and state layout are compatible, while the private completion field has not yet been observed. Rekall locates a unique extension-bundled executable automatically; when that is not possible, set `REKALL_CODEX_BINARY` to its absolute path. Schema generation exports files and exits; it does not start another App Server. Test transports using `REKALL_PIPE` deliberately skip the schema subprocess.

## Security

Rekall is designed for a **single-user workstation**. Any local process able to connect to the extension's pipe can interact with its IPC protocol, subject to the extension's own checks. Rekall does not add a separate authentication boundary. Owner/thread checks prevent accidental misrouting; they do not protect against an untrusted process with access to the same account and pipe.

A future Linux port must isolate the socket by UID or an equivalent private per-user runtime directory and validate ownership, permissions, and peer identity. See the historical [upstream socket-isolation report #8965](https://github.com/openai/codex/issues/8965). Current Linux CI uses isolated test sockets and does not establish live Linux support.

Read [SECURITY.md](SECURITY.md) for the trust model, handoff-integrity limits, and private vulnerability reporting.

## Data and privacy

Rekall does not export the transcript. It keeps the active thread snapshot in memory while processing state updates. Local `jobs/` files contain thread and job identifiers, timestamps, state, errors, token counts, paths, checksums, and the handoff text the user explicitly asked it to preserve. These files are excluded from Git and npm packages. Do not publish them or include them in bug reports.

Jobs default to `$CODEX_HOME/tools/rekall/jobs`, or `~/.codex/tools/rekall/jobs` when `CODEX_HOME` is unset. Current environment variables use the `REKALL_` prefix. Legacy `CONTEXT_COMPACT_*` names remain aliases, and an existing `$CODEX_HOME/tools/context-compact/jobs` directory is reused so active locks and history are not lost during migration. `REKALL_JOBS_DIR` can select a different local journal directory for isolated use.

## Verification and limits

The measured 78–90% reduction describes context tokens reclaimed in three individual runs, including one earlier user-reported run. It is not a percentage of the full model window, a latency distribution, or a guarantee for another task. The 15-minute deadline has not been validated against a representative workload distribution or very large threads.

The extension's compaction request does not accept custom instructions. `preserve` and `discard` guide the resumed model; they do not override the native compaction prompt or guarantee selective retention. Rekall does not change global Codex permissions or configuration.

## Development

```powershell
npm ci
npm test
npm pack --dry-run
```

[GitHub Actions](https://github.com/DitriXNew/rekall/actions/workflows/ci.yml?query=branch%3Amaster) runs the suite on Windows and Linux with Node.js 20 and 22, plus package validation. Tests use dedicated pipes/sockets, temporary job directories, and child processes. They must never target a live conversation. Passing Linux tests does not establish live extension IPC support.

The npm package uses an explicit file allowlist. Inspect `npm pack --dry-run` before publishing. Plugin and marketplace manifests live in `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json`; the MCP declaration is `.mcp.json`. The marketplace points to the plugin at the repository root.

The HOL scanner workflow uses a SHA-pinned action with reviewed scanner version `3.0.103`, requires a score of at least 80 and no critical/high findings, and uploads SARIF to GitHub code scanning. Network analyzers and automatic catalog submissions are disabled. For the same local gate in an isolated scanner installation, run:

```text
pipx install "plugin-scanner==3.0.103"
plugin-scanner scan . --format text --min-score 80 --fail-on-severity high
```

Scanner findings and optional analyzer availability are separate signals; a passing score does not establish runtime safety. Dependency updates are tracked by Dependabot, and `.codexignore` excludes local runtime and build artifacts without excluding source code from review.

This project is licensed under the [MIT License](LICENSE).

## Uninstall

Remove a plugin installation with `codex plugin remove rekall@rekall`. For a manual installation, run `codex mcp remove rekall` and remove the manually copied `skills/rekall` directory from your Codex home.

A worker that has already started continues until it records a result or reaches its deadline. Inspect its journal before handling a stale lock; never remove a lock while its recorded process is still running.

## References

- [Codex plugin marketplaces](https://learn.chatgpt.com/docs/enterprise/plugin-management#supported-formats)
- [Codex App Server: trigger thread compaction](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Issue #33398](https://github.com/openai/codex/issues/33398)
- [Issue #25074](https://github.com/openai/codex/issues/25074)
