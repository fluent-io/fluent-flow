# Real-kernel containment tests

[Native probes](../README.md) · [Runner](../../../README.md) · [Modules](../../../src/supervisor/README.md) · [Unit tests](../../unit/supervisor/README.md)

`npm run test:containment --workspace=@fluent-flow/runner` runs `containment.test.js` inside the namespace launcher with `vitest.containment.config.js`. The tests:

- a double-forked `setsid` grandchild stays in the worker cgroup;
- `killContainment` empties the cgroup and `populated` becomes 0;
- the shim exits 97 and never execs when enrollment fails;
- `probeContainment` creates only its own `ff-*` subtree and removes it on close.

`native-descendants.test.js` (Task 11) runs the real supervisor handlers in-process with real containment and the pinned Claude Code against a synthetic loopback model: a background process started by a native Bash tool call stays in the worker cgroup after the turn, blocks wrap-up (`owned_activity`) and is ended by `stopContained` (leaf `populated 0`, process gone, worktree kept). It skips only when the Claude binary is absent outside CI.

Every test fails with `containment_unavailable: <reason>` when `probeContainment()` does not verify a delegated scope. That is an open release proof, not a skip. Nothing here changes host cgroup, service or network configuration.

Result history (2026-11-04):

- First run: all four tests failed with `containment_unavailable: no_cgroup2_mount`. The launcher's namespace-local sysfs on `/sys` hid the host's cgroup2 mount at `/sys/fs/cgroup`. A direct run outside the launcher passed and was used only as a diagnostic.
- After the launcher kept the existing cgroup mount visible across its sysfs remount (see the [harness README](../harness/README.md)), the required `npm run test:containment` passed 4/4 on this host through the launcher (`mapping=caller`, lo only, `cgroup=preserved`). The host provides a delegated user scope; a host without one still fails with `containment_unavailable`.
- 2026-11-05 (Task 11): `npm run test:containment` passed 5/5 through the launcher, including `native-descendants.test.js`.
