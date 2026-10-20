# Dashboard collaboration client library

Browser-safe helpers for the collaboration board. No database imports — all
calls go through the same-origin proxy (`src/app/api/collab/v1/[...path]/route.ts`),
which signs actor assertions server-side.

- `api.ts` — `collabFetch` (envelope unwrap, ApiError with code/status/
  currentVersion, 204 handling) and `collabFetchAll` (cursor traversal with
  truncation flag).
- `types.ts` — client view of the shared contract (camelCase wire shapes;
  switch to package type-only imports as A's Zod schemas land per resource),
  including the immutable human decision and nullable saved review snapshot.
- `board.ts` — pure board logic: canonical move targets (project-scoped
  anchors, no client-side rank math), optimistic splice in server array order,
  cross-project drop rejection.
- `questions.ts` — question/permission encoding adapted from Flowly
  `shared/permission-question.ts` (MIT, pinned 13213f4; see
  THIRD_PARTY_NOTICES): parseQuestions/buildAnswers/answerReply semantics.
- `live.ts` — abortable latest-request guards and serial bounded refresh.
- `use-me.ts` — /me profile hook (capabilities per project, workspace
  capabilities, bootstrap eligibility).

Parent: [dashboard README](../../../README.md) ·
Contracts: [docs/plans/2026-10-19-collaborative-contracts.md](../../../../../docs/plans/2026-10-19-collaborative-contracts.md)
