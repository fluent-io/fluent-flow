# Projects

[Parent documentation](<../../../README.md>)

- [layout.tsx](<layout.tsx>) — Mounts the dashboard shell (sidebar, header and Current project selector).
- [page.tsx](<page.tsx>) — Lists the signed-in user's projects grouped by client, with the existing creation form where the user has workspace `project.admin`.

Child directories:

- [[id]](<[id]/README.md>)

The views live in [projects-view.tsx](<../../components/collab/projects-view.tsx>). Project data comes from `/me` and the safe overview API; see the [collaboration API](<../../../../fluent-flow/src/collab/README.md>).
