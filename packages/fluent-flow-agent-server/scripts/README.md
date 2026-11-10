# Scripts

[Agent server README](../README.md) · [Docker support files](../docker/README.md)

`smoke.mjs` runs one network-isolated agent-server scenario with two launchers: enrollment and private state, two real runner slots, ACP child lifecycle, claim ownership loss, bounded-capacity scheduling, fake Git worktrees, secret containment, health status, and complete shutdown. A fake loopback control plane drives both launchers; fake `git` and the ACP fixture (`tests/unit/fake-acp-agent.js`) replace the network and the provider.

## In-process launcher

`npm run smoke --workspace packages/fluent-flow-agent-server` starts the server from source in the current process. Fake `git` and `gh` executables on the child PATH satisfy the startup tool probe.

## Container launcher

`AGENT_SERVER_IMAGE=<image> CONTAINER_CLI=<docker|podman> npm run smoke:image --workspace packages/fluent-flow-agent-server` runs the same scenario against a prebuilt image (`CONTAINER_CLI` defaults to `docker`):

```bash
docker build -f packages/fluent-flow-agent-server/Dockerfile -t fluent-flow-agent-server:test .
AGENT_SERVER_IMAGE=fluent-flow-agent-server:test npm run smoke:image --workspace packages/fluent-flow-agent-server
```

Before the scenario the script inspects the image (numeric `1000:1000` user, entrypoint, `/healthz` health check, OCI labels, no credential-named environment variables) and runs, with `--network none` as UID 1000, `git`, `gh`, `claude-agent-acp` and `codex-acp` (`--version`), a layout check (no `curl`, `ssh`, Docker socket, `.git` or tests under `/app`), and a write check on fresh named volumes at `/work` and `/home/node/.fluent-flow`.

The server container is started with the deployment hardening of the Compose example: `--init`, `--read-only`, tmpfs `/tmp` and `/home/node`, `--cap-drop ALL`, `no-new-privileges`, `--user 1000:1000`, `--deployment self_hosted`, a read-only provider secret file holding a sentinel, the enrollment token on the command line, and the health listener on `127.0.0.1` at a free port discovered by the script. `FLUENT_FLOW_HEARTBEAT_MS=75` shortens the heartbeat so ownership loss is observed quickly; no other timing is overridden.

Design choices:

- **Networking.** `--network host` lets the container reach the loopback fake control plane and lets the script reach the loopback health listener without publishing ports. The control-plane URL must be HTTPS or loopback HTTP, so a bridge network would require TLS.
- **Ownership.** Podman runs with `--userns keep-id:uid=1000,gid=1000` so the invoking user's bind mounts are owned by container UID 1000 (rootless Podman without it maps container UID 1000 to an unrelated sub-UID). Docker needs no mapping when the host UID is 1000; otherwise the script makes its temporary mount directories world-writable and the secret file world-readable (they live in a mode-0700 temporary directory) and relaxes modes inside the container before cleanup.
- **Mounts.** The fake `git` directory and the ACP fixture are mounted read-only; the directory is prepended to the container `PATH` through `-e PATH`. The fixture is mounted inside `/app` so it resolves the image's installed ACP SDK.
- **Inspection.** State and Git files written by the container are read with `exec`, so no host permission mapping is needed to assert modes (`0700` state directory, `0600` state file), worktree removal and the stored clean HTTPS remote.
- **Port claims.** The script claims only the health port. Inside the container it maps every open socket of every container process to `/proc/net/{tcp,tcp6,udp,udp6}` listeners and asserts that the only listening or bound port is the health port.
- **Shutdown.** `SIGTERM` is sent to the container and the script requires exit code 0 within 15 seconds, then checks the health port is closed and that container logs, Git trace, reports, events, health responses and the ACP trace contain none of the sentinel secrets.
- **Cleanup.** The container, named volumes and temporary directory are always removed.
