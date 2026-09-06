# Security policy

## Supported environment

Rekall is intended for a single-user workstation running the Codex VS Code extension on Windows or macOS. The extension version and platform verification limits are listed in [README.md](README.md#compatibility-and-extension-updates). Shared machines, multi-tenant hosts, and live Linux IPC are outside the supported deployment model. Security fixes target the latest version on `master`; older versions do not have a separate maintenance branch.

## Trust boundary

Rekall connects to the extension's existing local named pipe on Windows or Unix socket on macOS. It does not create or administer that endpoint, configure its access control, or add a separate authentication layer. On macOS it checks the current UID, rejects symlinks at the IPC directory and socket paths, and requires both to have no group/other permissions. It uses only `$CODEX_HOME/ipc/ipc.sock` (default `~/.codex/ipc/ipc.sock`), with no legacy shared-socket fallback. These filesystem checks do not authenticate another process running under the same account. Any local process that can connect to the endpoint can participate in the extension's IPC protocol, subject to the extension's own checks. Thread IDs and owner IDs are routing and consistency checks, not credentials. Do not expose or forward this endpoint over a network.

The operating-system account, the Codex extension, the installed Rekall code, and processes with access to that account's files and IPC endpoint belong to the trusted computing base. Rekall's schema, owner, thread, user-input, and handoff checks reduce accidental misrouting and unintended continuation; they do not isolate mutually untrusted local processes.

Handoff SHA-256 detects a changed handoff relative to the recorded journal. It is not a signature: a process that can rewrite both the handoff and its journal can also replace the recorded checksum. Handoffs and journals are stored unencrypted under the user's Codex directory, with filesystem permissions inherited from that environment. Treat their contents as private and restrict access to the account and its files.

`REKALL_ALLOW_UNVERIFIED=1` overrides only the extension-version allowlist. It does not establish compatibility, authenticate the pipe, or disable the other validation checks. Use it for deliberate compatibility investigation and inspect the warnings returned by `probe_compaction`.

## Requirements for a Linux port

A future Linux adapter must use a socket location isolated by UID (or an equivalent private per-user runtime directory), verify directory/socket ownership and permissions, and authenticate the peer where supported. A globally shared `/tmp` socket pathname is insufficient. Cross-user socket isolation was the subject of [upstream issue #8965](https://github.com/openai/codex/issues/8965); that historical report is not a claim about the current extension's behavior. Passing Linux tests with a synthetic socket does not establish a secure live Linux deployment.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/DitriXNew/rekall/security/advisories/new) for security defects. Include the Rekall version or commit, operating system, extension version, expected trust boundary, and a minimal reproduction using synthetic data.

Do not post credentials, raw handoffs, transcripts, job journals, real thread/owner/job/turn IDs, or personal filesystem paths in public issues. Redact these from probe output too. For an ordinary extension compatibility failure, use the [new extension version issue template](https://github.com/DitriXNew/rekall/issues/new?template=new-extension-version.yml).
