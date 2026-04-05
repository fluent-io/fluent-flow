---
name: fluent-hive repo
description: Next.js monorepo (turborepo) — Victor's separate project that uses Fluent Flow for reviews
type: reference
---

`fluent-io/fluent-hive` is a separate repo with a Next.js web app in a turborepo monorepo. It uses Fluent Flow for automated PR reviews.

- PR #3: landing page conversion (HTML → Next.js components)
- Has CI workflow (`ci.yml`), deploy workflow, and `pr-review.yml` (reusable from fluent-flow)
- Config: `default_agent: "claude-code"`
- Needs onboarding: `.github/fluent-flow.yml` must be committed to `main` branch (was only on feature branch as of 2026-03-24)
