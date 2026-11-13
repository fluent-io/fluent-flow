# PR150 preview acceptance at 8a0a95f

[Parent documentation](../README.md) | [PR150](https://github.com/fluent-io/fluent-flow/pull/150)

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

At this evidence capture CI still failed the connector deadlock, independently diagnosed from the actual CI PostgreSQL lock pair. This evidence is pinned to 8a0a95f; a later head requires deployed-head verification and relevant smoke before final acceptance. No merge or production deployment is implied.
