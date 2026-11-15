# Claim-backed execution PR evidence

[Implementation plan](../2026-11-13-claim-data-parity.md) · [Verification ledger](../2026-11-13-chat-claims-progress.md)

These screenshots are permanent review evidence from the production Next.js
build, real collaboration HTTP/MCP routes and PostgreSQL, with the scripted ACP
runner used by `packages/dashboard/tests/collab/chat-drawer-actual.browser.mjs`.
All accounts, tasks, agents and content are isolated test fixtures. They do not
show a live paid-provider or GitHub execution.

- `01-task-desktop.png`: board-preserving task drawer.
- `02-session-desktop.png`: attended session after five turns.
- `03-session-mobile.png`: mobile session and composer.
- `04-task-mobile.png`: task overview after ending the session.
- `05-settings-desktop.png`: independent summary settings, with no attended-execution panel.
- `06-revoked-session.png`: private session cleared after authority loss.
- `07-structured-session.png`: permission and elicitation interaction.

The PR embeds these images from its commit. The browser harness creates no
screenshots unless its evidence directory is explicitly supplied. These files
are not temporary diagnostics, private backups or retirement authorization.
