# ACP adapter lockfile

[Docker support files](../README.md) · [Agent server README](../../README.md)

`package.json` and `package-lock.json` here pin the two ACP adapters that the agent server image installs. The package is private and is not an npm workspace. Only the Dockerfile reads it.

- `package.json` lists exact versions of `@agentclientprotocol/claude-agent-acp` (0.101.0) and `@agentclientprotocol/codex-acp` (2.6.0). They provide the `claude-agent-acp` and `codex-acp` executables that `--provider claude-code` and `--provider codex` start.
- `package-lock.json` (lockfile version 3) pins every transitive package with its registry URL and integrity hash. The image build runs `npm ci --omit=dev --prefix /opt/adapters`, which fails if `package.json` and the lockfile disagree or an integrity hash does not match.

The image therefore contains the same adapter code on every build, and a new upstream release changes nothing until someone bumps these files.

## Bump an adapter

1. Change the version in `package.json`.
2. From this directory run `npm install --package-lock-only --ignore-scripts` to rewrite the lockfile without installing anything.
3. Read the lockfile diff. Check that the adapter's `@agentclientprotocol/sdk` dependency is still compatible with the server, which uses `@agentclientprotocol/sdk` 2.4.0 in `../../package.json`.
4. Build the image and run the container smoke test from the repository root:

   ```bash
   docker build -f packages/fluent-flow-agent-server/Dockerfile -t fluent-flow-agent-server:test .
   AGENT_SERVER_IMAGE=fluent-flow-agent-server:test npm run smoke:image --workspace packages/fluent-flow-agent-server
   ```

   The smoke test runs `claude-agent-acp --version` and `codex-acp --version` in the built image. It drives the server with a fake ACP agent, so it does not exercise a real adapter session. Try one real claim with each provider on a staging server before you release.
5. Commit both files together. A release publishes the image only after the same smoke test passes on the release candidate.
