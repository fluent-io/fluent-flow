# Supervisor unit test helpers

[Supervisor unit tests](../README.md) · [Modules](../../../../src/supervisor/README.md)

| File | Purpose |
| --- | --- |
| `dispatch-fakes.js` | Shared fixtures for supervisor dispatch tests, moved unchanged from `native-dispatch.test.js` (Task 11): a temp Git repository, in-memory containment operations (leaves in a map, `kills`, spawned `children` so a test can emit a worker's exit, and optional per-leaf `pids`), a contract-faithful fake backend, `setup()` over the real ledger and supervisor handlers, the `launch()` command and `ledgerLines()`. Nothing here signals a process or touches a cgroup. |
