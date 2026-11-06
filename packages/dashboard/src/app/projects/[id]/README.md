# Project detail

[Parent documentation](<../README.md>)

- [page.tsx](<page.tsx>) — Project overview, run and test instructions, Board link, Settings link for project or membership admins, and overview editing for `project.admin`. Keyed by project id so a switch drops the previous overview and any unsaved draft.

Reads `GET /api/collab/v1/projects/:id` and saves `PATCH /api/collab/v1/projects/:id/overview` with the loaded version. A 409 keeps the draft and offers a reload. Unknown and foreign projects show the same "not found" message.
