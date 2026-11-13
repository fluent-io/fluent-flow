# PR150 preview acceptance

[Parent documentation](../README.md) | [PR150](https://github.com/fluent-io/fluent-flow/pull/150)

## Final acceptance at c380097

Final dashboard/API revision `c38009756b6fa2bfa9f3adb55152b26e07f36f04` was verified in the running preview containers, including the compiled NO KEY UPDATE fence and matching Preview App OAuth client. Production remained at 39c9ff4.

Actual GitHub sign-out/sign-in succeeded again. Database read-back preserved the same single default workspace, manager membership and role IDs, both projects with exact repo/null links, one backlog task and zero target-org runs. Desktop and 390px mobile navigation checks passed on Repos, Projects, linked detail, Settings and Board with empty document-start error/rejection/console.error arrays; desktop Runtime.exceptionThrown was zero, and mobile content fit 390px without overflow. The separate synthetic viewer 403/422 checks passed again on this head. The existing favicon 404 remains documented.

The actual deployed service functions and preview PostgreSQL also passed the controlled session-enqueue/observation concurrency gate, persisting two sessions. Stale epoch heartbeat returned 409 and revoked-host heartbeat returned 401. This used only a synthetic foreign-tenant fixture, with no executor or model launched, and revoked its fixture host afterward. It did not mutate the real user's projects/task or production.

[CI 43359430111](https://github.com/fluent-io/fluent-flow/actions/runs/43359430111) passed all six jobs; [preview 43359428101](https://github.com/fluent-io/fluent-flow/actions/runs/43359428101) passed. Root tests: 2,362 passed / 10 existing opt-in skips, plus CI separately passed all ten opt-in claim SQL cases. Independent GPT and GLM reviews are clean. Production acceptance remains pending authorized deployment and verification; no merge or production deployment occurred.

- [Final desktop console checks](pr150-final-console-desktop.json)
- [Final mobile console checks](pr150-final-console-mobile.json)
- [Final OAuth catalog read-back, resource IDs redacted](pr150-final-oauth-readback.json)
- [Final runtime verification](latest-runtime.json)
- [Final database read-back](latest-database-readback.json)
- [Deployed connector concurrency/fencing result](latest-fence.json)
- [Final separate-fixture denials](latest-negative-checks.json)

## Initial real OAuth and creation at 8a0a95f

Tested dashboard/API revision: `8a0a95ffd81e2f3eeadb73117c9187e2f5447d37`, deployed at https://pr-150-preview.fluentflow.tech. Production was read only; no production fixture or permission changes were made.

The preview was verified to use an independent database volume, the existing Preview App installation, matching Preview App OAuth client and a covered controlled repository. A verified preview-only fixture created the established org/admin/principal/repository state with zero target-org workspaces and projects. It did not mint a session or password for the real account.

The parent agent completed actual GitHub OAuth in the user's local Chrome using its existing GitHub session; no password was entered, read or extracted. Read-back immediately after sign-in found one default workspace, one system manager membership with project.admin and zero automatically created projects. Repos creation opened the linked project, and list/detail displayed fluent-io/fluent-flow. Settings created a standalone project with a null repo link. A manually created task persisted in backlog, with zero runs. Actual sign-out/GitHub sign-in again preserved the same workspace ID, membership ID, role ID and two project rows.

- [Desktop projects](pr150-projects-desktop.png)
- [390px projects](pr150-projects-mobile.png)
- [Linked detail](pr150-linked-detail.png)
- [Created backlog task](pr150-board-task.png)
- [Prospective desktop console smoke](pr150-console-desktop.json)
- [Prospective mobile console smoke](pr150-console-mobile.json)
- [Separate fixture viewer desktop](viewer-desktop.png)
- [Separate fixture viewer mobile](viewer-mobile.png)
- [Read-back summary](readback-summary.json)
- [Separate fixture negative-check result](negative-checks.json)

Console monitoring was installed after the original OAuth/creation actions. All ten subsequent desktop/mobile route checks passed with empty document-start window.error, unhandledrejection and console.error arrays; mobile widths were 390/390, and mobile CDP exception/error counts were zero. Desktop raw CDP events were not fully evaluated. These results do not retroactively cover the original actions.

A separate headless synthetic password session verified disabled target-org creation, 403 for direct mutation, and 422 invalid_repo for a different-org repository despite admin rights in another workspace. It did not replace real OAuth verification. That fresh browser logged one existing /favicon.ico 404; the same endpoint returned 404 in production. Application error arrays and preview API server errors were empty.

Real preview OAuth did not log an installation-discovery 403. The production 403 failure path is covered separately by the actual production diagnostic and the real-PostgreSQL automated regression with a mocked upstream 403.

The initial 8a0a95f CI failure was diagnosed from the actual PostgreSQL lock pair and fixed in c380097. The final acceptance section above records the green CI and deployed-head re-verification. No merge or production deployment is implied.
