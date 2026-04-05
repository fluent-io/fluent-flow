---
name: TDD workflow preferences
description: Victor's TDD workflow — Red/Green/Refactor with breaking change verification step
type: feedback
---

Follow the full TDD cycle as specified in CLAUDE.md:
1. Red — write a failing test first
2. Green — write minimal code to pass
3. Refactor — clean up
4. Verify — introduce a real-world breaking change to confirm tests catch it
5. Undo — revert the breaking change, confirm green
6. Build — ensure lint/compiler/build passes

**Why:** Victor values deterministic, provable correctness. The breaking-change verification step (step 4) is non-standard but important — it proves the tests actually guard the behavior, not just pass trivially.

**How to apply:** Always follow this cycle when implementing features or bug fixes. Don't skip the breaking-change verification step.
