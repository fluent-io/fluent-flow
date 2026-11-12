# Component tests

[Dashboard README](../../README.md) · [Collaboration regressions](../collab/README.md) · [API route tests](../api/)

Vitest suites for dashboard UI components and the pure helpers behind them. The agent suites render with jsdom and Testing Library. The pipeline suites test plain modules.

- [auth-guard.test.tsx](auth-guard.test.tsx): environment-specific App onboarding, safe preview guidance and sign-out, with collaboration-only access preserved.
- [repo-card.test.tsx](repo-card.test.tsx): repo project creation, org and capability matching, unavailable states, safe errors, and navigation.
- [new-agent-dialog.test.tsx](new-agent-dialog.test.tsx): the New agent server dialog. Covers the form and its contract defaults, provider and deployment options, organization choice, capacity bounds (1 to 16), the exact POST body, error handling, the enrollment step (command shown verbatim, copy, 15-minute single-use notice, waiting state, self-hosted and local setup text) and the connection check that polls agent detail until a slot is online.
- [agent-table.test.tsx](agent-table.test.tsx): the Agents list. Columns, provider badges, `active / capacity` slots, deployment labels, row navigation, and no provider secret names in the rendered output.
- [agent-detail-header.test.tsx](agent-detail-header.test.tsx): the agent detail header. Server name, status, provider, slots against capacity (a dash when capacity is unknown), and deployment.
- [pipeline-stage-config.test.ts](pipeline-stage-config.test.ts): stage labels and styling per claim type.
- [pipeline-summary.test.ts](pipeline-summary.test.ts): pipeline list summary helpers.
- [verification-panel.test.ts](verification-panel.test.ts): the model behind the red and green verification panel.

The `POST /api/agents` route has its own tests in [../api/agents.test.ts](../api/agents.test.ts). The slot, capacity and deployment fields these components display come from the aggregate query described in the [database README](../../../db/README.md#agent-aggregates).
