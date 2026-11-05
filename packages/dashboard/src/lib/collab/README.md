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
  Task 9: `pendingFromV2` maps the plural pending-request DTO (each choice keeps
  its own behavior; the deny/reject id regex applies only to legacy choices
  without one), `buildSelections` builds native per-question-id selections by
  option id (`optionIds`, fix 1: a shown label may be a scrubbed local value;
  typed text separate and sent only with content) and
  `requestCommand` names the request id plus, for native requests, its
  generation and fingerprint. `loadPendingRequests` follows the plural API's
  cursor to its end (no page cap) and reports the list incomplete only when the
  server repeats a cursor.
- `execution-copy.ts` — Task 12 public execution copy: `EXECUTION_MESSAGES` (the approved code-to-message table), `READINESS_COPY` (label and message for each of the seven readiness states), `executionErrorMessage` (own-key lookup, null for unknown codes so raw codes and details never render), backend labels, an allowlisted `policyText` mirroring the server's `sanitizePolicy`, and `capacityText` (unknown availability stays unknown).
- `live.ts` — abortable latest-request guards and serial bounded refresh.
- `use-me.ts` — /me profile hook (capabilities per project, workspace
  capabilities, bootstrap eligibility). `MeProvider` lets the dashboard shell
  share one catalog with the page and revalidates it every 5s on the bounded
  `pollResource` lifecycle; outside it, `useMe()` loads its own copy with the
  same return shape. A 401/403 drops the catalog and sets `denied`; other failures
  keep the last confirmed one and set `error`.
- `current-project.tsx` — Current project selection shared by the header,
  Board, task creation, task detail and attention. The choice is saved in
  `localStorage` under a principal + session-version key and only exposed when
  a `/me` catalog loaded for that same principal and session version contains
  it; a saved id that the catalog lacks is removed. While
  `/me` loads the selection is pending, never treated as revoked. If the
  catalog has never loaded, `catalogError`/`retryCatalog` let pages show a
  retry instead of waiting forever; `accessLost` reports a refused catalog.
  Route sync guards reset when a route stops naming a project, so Back/Forward
  re-syncs the header. Board,
  project and task routes that name a project take precedence and update it.

Parent: [dashboard README](../../../README.md) ·
Contracts: [docs/plans/2026-10-19-collaborative-contracts.md](../../../../../docs/plans/2026-10-19-collaborative-contracts.md)
