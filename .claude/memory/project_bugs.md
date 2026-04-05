---
name: Fluent Flow bugs — status as of 2026-03-22
description: Three bugs found during code review — all three fixed and committed in 23883ff
type: project
---

**Bug 1: FIXED** — `delivery` config stripped by Zod. Added `DeliveryConfigSchema` to `RepoConfigSchema` and `MergedConfigSchema` in `src/config/schema.js`. Regression tests in `tests/unit/schema.test.js`.

**Bug 2: FIXED** — Missing `delivery` in pause/resume notifications. Added `delivery: config.delivery` to `notifyPause()` and `notifyResume()` calls in `src/engine/pause-manager.js`.

**Bug 3: FIXED** — No startup env var validation. Created `src/config/env.js` with `validateEnv()`. Wired into `src/index.js` startup. Tests in `tests/unit/env.test.js`.

**How to apply:** All fixes committed in `23883ff`. If new bugs are found, add them here.
