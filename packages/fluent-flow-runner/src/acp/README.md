# ACP runner primitives

This directory contains the runner-local boundary for Agent Client Protocol v2 execution. The runner uses the official `@agentclientprotocol/sdk/experimental/v2` entrypoint and owns one direct ACP child for an active claim.

## Command resolution

`resolveAcpCommand({ agentType, command, args })` returns a discrete executable and argument array. Named adapters resolve as follows:

| Agent type | Local invocation |
| --- | --- |
| `claude-code`, `claude-agent-acp` | `claude-agent-acp` |
| `codex`, `codex-acp` | `codex-acp` |
| `opencode` | `opencode acp` |

Other agent types require an explicit local executable. Commands are local runner configuration and never contain prompt or service-provided process configuration. Shell command text is rejected.

On Windows, native `.exe` and extensionless executables run directly. A named adapter installed through npm may have a `.cmd` shim; the resolver uses only the adjacent known package's declared `bin` entry and launches that JavaScript file through `process.execPath`. It never executes or parses the shim. Custom `.cmd` wrappers are rejected.

## Process ownership

`spawnAcpProcess({ bin, args, cwd, env, spawnImpl, stderrLimitBytes })` launches one direct child with `shell: false`, piped standard streams, and no detachment. It exposes stdin and stdout as Web streams for the SDK, retains only the configured stderr tail, settles one awaited exit result, and closes stdin idempotently. `kill(signal)` signals only the direct child. Descendant discovery, process groups, host process scans, and platform-specific process controls are outside this boundary.

## Update normalization

`normalizeAcpUpdate({ claimId, sessionId, seq, update, secretValues, maxPayloadBytes })` maps ACP v2 session updates to the application event kinds while preserving a bounded redacted raw update. Updates with ACP entity identifiers receive stable `{ type, id }` identity, so chunks and later upserts address the same entity. Repeated state snapshots remain independent snapshots, and unknown extensions remain `unknown` events.

Normalization recursively redacts known credential fields, authorization and secret-assignment patterns, common token formats, private keys, and exact live secret values supplied by the caller. The serialized payload byte limit is checked after redaction and before the event is returned. Invalid or oversized payload errors never include payload contents.
