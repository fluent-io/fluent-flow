# Docker support files

[Agent server README](../README.md) · [Adapter lockfile](adapters/README.md) · [Scripts and smoke tests](../scripts/README.md)

This directory holds what the image build copies in besides the server source. The Dockerfile and the Compose files sit one level up, in the package root.

- [adapters/](adapters/README.md): the pinned Claude and Codex ACP adapters that the image installs. See that README to bump a version.

## Image

The Dockerfile is built from the repository root so it can see the workspace lockfile:

```bash
docker build -f packages/fluent-flow-agent-server/Dockerfile -t fluent-flow-agent-server:test .
```

It has two stages. The first installs the server's production dependencies from the committed lockfile and copies `bin` and `src`. The second starts from a digest-pinned `node:24.22.2-bookworm-slim` and adds:

- Git and the GitHub CLI, from GitHub's apt repository. `curl` is installed only to fetch the repository key and is purged in the same layer.
- The adapters in `/opt/adapters`, installed with `npm ci --omit=dev` from the lockfile in `adapters/`. The build runs `claude-agent-acp --version` and `codex-acp --version` so a broken install fails the build. `/opt/adapters/node_modules/.bin` is on `PATH`.
- The server in `/app`, with `/work` and `/home/node/.fluent-flow` created for UID 1000 (modes 0755 and 0700).

The image runs as `1000:1000` with `HOME=/home/node`, `WORKDIR /work` and `NODE_ENV=production`. Its entrypoint is the agent server, so arguments follow the image name. `HEALTHCHECK` calls `http://127.0.0.1:3860/healthz` every 30 seconds with a 20 second start period, so a custom `--health-host` or `--health-port` needs its own check. It carries OCI labels for source, title, description and license. Nothing is installed at runtime, and the container needs no Docker socket.

Release builds publish `linux/amd64` and `linux/arm64`. The workflow lints the Dockerfile with the rules in the repository's `.hadolint.yaml`. The `.dockerignore` in the repository root keeps tests, docs, scripts and Compose files out of the build context.

## Compose files

Both files start one service called `agent-server` in the project `fluent-flow-agent-server`. They use the published `:latest` image, `init: true`, `restart: unless-stopped`, a read-only root filesystem with tmpfs for `/tmp` and `/home/node`, `cap_drop: ALL`, `no-new-privileges`, named volumes `fluent-flow-state` and `fluent-flow-work`, and no published ports. The provider credential is a file-based secret mounted at `/run/secrets/provider-auth`. UID 1000 must be able to read the host file.

| File | Use | Required variables |
|---|---|---|
| [../docker-compose.yml](../docker-compose.yml) | First start with a dashboard enrollment token | `FLUENT_FLOW_SERVER`, `AGENT_PROVIDER`, `FLUENT_FLOW_ENROLLMENT_TOKEN`, `PROVIDER_AUTH_FILE` |
| [../docker-compose.durable-token.yml](../docker-compose.durable-token.yml) | Operators who mount a durable `ff_` token instead of enrolling | `FLUENT_FLOW_SERVER`, `AGENT_PROVIDER`, `PROVIDER_AUTH_FILE`, `FLUENT_FLOW_TOKEN_SECRET_FILE` |

`AGENT_CAPACITY` is optional in both and defaults to 2. Missing required variables stop Compose with the message in the file. The two files are separate because one variable cannot be both required and optional in a single Compose file. Both pass `--deployment self_hosted`.

The repository root `docker-compose.yml` has a third variant, the `hosted-agent` profile, for platform operators. See the [agent server README](../README.md#hosted).

`docker compose down` reads the same required variables, so set them (placeholders work) before you run it.

## Related

- [Agent server README](../README.md#self-hosted-docker): run commands and operations notes.
- [Scripts README](../scripts/README.md): `npm run smoke:image` builds nothing and tests an image you built.
