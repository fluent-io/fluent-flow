# Product Positioning and Competitive Landscape

**Status:** Product direction

**Audience:** Maintainers, contributors, and product owners deciding what Fluent Flow should build.

**Post-read action:** Use this document to accept or reject roadmap work based on whether it strengthens Fluent Flow as an open-source verification and merge-control product for agent-written code.

## Decision

Fluent Flow will be an **open-source, self-hostable competitor to AI code-review and agentic change-management products**, with paid enterprise support.

Its category and promise are:

> **The merge gate for agent-written code.**
>
> Agent writes it. Fluent Flow verifies it. You ship it.

A stricter policy expression is:

> **No evidence, no merge.**

Fluent Flow is not a general agent framework or workflow engine. Its job is to turn untrusted software changes and reviewer findings into independently executed evidence, then enforce the organization's merge policy.

The direct commercial competitor is CodeRabbit. Mastra and Hatchet are adjacent infrastructure products that solve different jobs.

## Customer and job

The primary buyers and operators are platform engineering, developer experience, application security, and engineering leadership teams adopting multiple coding agents.

Their problem is not access to another coding model. It is that autonomous agents can generate software changes faster than humans can safely validate them.

They hire Fluent Flow to answer:

> Can this agent-written change cross the merge boundary, and what evidence supports that decision?

The product must work with the customer's existing choices:

- coding agents such as Claude Code, Codex, Aider, or custom harnesses;
- reviewers such as Fluent Flow's built-in reviewer, CodeRabbit, GitHub reviewers, or security tools;
- repositories and CI systems controlled by the customer;
- customer-owned model credentials and execution environments.

## Target product contract

The deterministic verification machine is in development and unreleased. The target change-assurance protocol is:

1. A coding agent creates or updates a pull request.
2. One or more independent reviewers produce blocking findings.
3. Fluent Flow binds the findings and intent to the exact reviewed commit.
4. A verifier converts each blocking finding into an executable requirement and authors tests against the broken commit, before the fix exists.
5. Each new test must fail by assertion on the broken commit. Assertion-aware result classification excludes infrastructure and syntax failures; repeated red execution reduces flake risk.
6. Fluent Flow stores the authoritative verification record and seals the relevant test, fixture, dependency, lockfile, and framework configuration inputs.
7. A fixer agent implements the change only after the red artifacts are sealed. Target policy may require the fixer, reviewer, and verifier to use different registered agents or model providers.
8. Fluent Flow checks the sealed inputs for tampering and executes the pinned tests and full suite without LLM judgment.
9. The change is re-reviewed and evaluated against organization policy.
10. Fluent Flow merges the change or escalates it to a human.

The in-development verifier enforces temporal and cryptographic independence, not identity-based separation of duties: red artifacts are created before the fix and protected by server-held hashes, but current claim routing may assign verification and fixing to the same runner. Identity and role separation is target policy work, not shipped behavior.

The primary output is an evidence record, not another review comment. A complete record links:

```text
finding
  -> requirement
  -> test
  -> pre-fix commit
  -> red execution
  -> sealed artifact hashes
  -> fix commit
  -> green execution
  -> full-suite result
  -> reviewer and verifier identities
  -> policy decision
```

## Competitive landscape

### Summary

| Product | Customer question | Primary output | Relationship to Fluent Flow |
|---|---|---|---|
| Mastra | How do we build and observe an AI agent? | Agent application and runtime | Complementary; its agents can submit changes through Fluent Flow |
| Hatchet | How do we execute workflows and background tasks reliably? | Durable task and workflow execution | Complementary infrastructure; not the customer-facing product |
| CodeRabbit | What problems may exist in this change, and can an agent repair them? | Reviews, findings, fixes, plans, and security analysis | Direct competitor and useful findings source |
| Fluent Flow | Has this change earned the right to merge? | Executable evidence plus an enforced merge decision | Open-source, self-hostable change assurance |

Fluent Flow is not universally better than these products. It is the better offer when the customer's job is governing autonomous software changes across multiple agents and producing auditable evidence at the merge boundary.

### Mastra

Mastra is a TypeScript framework for building agents. Its product surface includes models, tools, memory, MCP, workflows, scoring, and observability.

Fluent Flow should not compete on that surface. A Mastra customer must still design the software-development workflow, integrate Git hosting, separate author and verifier roles, execute repository tests, protect verification artifacts, and implement merge policy.

Fluent Flow provides that finished domain product. Mastra helps an agent act; Fluent Flow constrains what an agent may ship.

### Hatchet

Hatchet is a durable orchestration engine for AI agents, background tasks, and mission-critical workflows. Its workers, routing, retries, concurrency controls, heartbeats, event waits, and monitoring overlap with Fluent Flow's internal claim machinery.

That overlap does not define the final offer. A Hatchet customer would still need to build:

- Git provider lifecycle and repository authorization;
- author, reviewer, and verifier separation;
- red-before-fix and green-after-fix verification;
- artifact integrity protection;
- pull-request checks and merge policy;
- the evidence and escalation experience.

Hatchet sells orchestration primitives. Fluent Flow sells a governed software-delivery outcome. Internal execution machinery must remain an implementation concern rather than the marketing category.

### CodeRabbit

CodeRabbit is the direct competitor. Its public product is Agentic Change Management across pull-request, IDE, CLI, planning, triage, security, and coding-agent surfaces. It has stronger distribution, broader source-control support, a mature review experience, and a large catalogue of analysis integrations. Its Enterprise offer already includes self-hosting, SSO/RBAC, audit logging, multi-organization support, SLA support, and vendor-security review.

Fluent Flow's distinct commercial position is not the existence of self-hosting controls. It is an MIT-licensed core that can be self-hosted without an enterprise contract, customer-controlled BYOK execution, reviewer and agent neutrality, and a merge decision backed by independent executable evidence rather than a vendor-owned review-and-fix loop.

Fluent Flow should not claim to be a better general-purpose reviewer. Its differentiation is the independent verification boundary:

- verification runs in the customer's real repository environment with dependencies installed;
- the test must demonstrably fail before the fix exists;
- the fix agent does not control the server-held verification record;
- green execution contains no LLM judgment;
- failed, missing, incomplete, skipped, or tampered evidence can block automatic merge;
- findings may come from any reviewer, including CodeRabbit.

CodeRabbit's public documentation says its custom checks run read-only and cannot run the repository test suite or arbitrary repository code. Its Autofix documentation states: “Even if verification fails, the generated changes are still delivered so you can continue iterating.” Fluent Flow's target contract is a fail-closed merge gate, not delivery of a best-effort fix.

A useful integration position is:

> CodeRabbit finds issues. Fluent Flow makes their remediation independently verifiable.

## Open-source and self-hosting model

Fluent Flow is currently MIT licensed. The core server, dashboard, runner, verification protocol, adapters, and policy engine should remain inspectable and self-hostable. Changing the license is a separate legal and commercial decision; the product direction does not require a license change.

Self-hosting must be a supported product path rather than a source-code availability claim. The repository currently contains reference Docker Compose deployment for the control plane and a separate runner deployment, but this is not yet a supported production self-hosting offer. Runner distribution and deployment authentication still have known gaps. A production-quality offer additionally needs:

- versioned and signed releases;
- documented upgrades and database migrations;
- backup and restore procedures;
- health checks and operational diagnostics;
- high-availability guidance;
- Kubernetes or equivalent production deployment artifacts when customer demand justifies them;
- explicit outbound network and secret-management requirements;
- offline or restricted-network installation guidance.

Customer-controlled runners remain the default execution model. Repository code, dependencies, model credentials, and test execution stay in customer-controlled infrastructure.

## Enterprise offer

Enterprise revenue should come from operational assurance and support, not from making the core verifier unusable without proprietary modules. All five core product surfaces—merge gate, evidence record, policy as code, customer-controlled runners, and integrations—remain available in the MIT-licensed product. Enterprise customers pay for supported and certified operation, service levels, deployment assistance, security response, and commercial terms; they do not pay to unlock the core assurance model.

The enterprise offer should include:

- support SLAs and an escalation channel;
- deployment architecture review and onboarding;
- long-term supported releases and security backports;
- upgrade, backup, restore, and disaster-recovery assistance;
- SSO, SCIM, RBAC, organization policy, and audit/SIEM integration;
- signed release provenance, SBOMs, and security-response commitments;
- air-gapped or private-network deployment support;
- compliance and vendor-security review materials;
- commercial licensing or indemnification if customers require different terms;
- an optional managed control plane with customer-controlled runners.

Commercial packaging should align with autonomous change volume rather than developer headcount. A proposed model to validate with customers is a base price per active repository with included verified-change volume, plus enterprise support and deployment terms. Customer model costs remain separate under BYOK.

## Assurance model

### Evidence, not proof of correctness

The deterministic verifier establishes that a sealed test distinguishes the reviewed broken state from the fixed state and that the fixed state passes the declared checks. It does not prove that:

- the generated requirement faithfully represents the original finding;
- the authored test adequately represents the requirement;
- every behavior affected by the fix is covered;
- unrelated behavior is safe;
- the entire program is correct.

Product language must therefore promise **independent executable evidence**, not formal proof or guaranteed correctness.

### Coverage ledger

Every blocking finding and material change surface should appear in a coverage ledger as one of:

- covered by new red/green evidence;
- covered only by the existing suite;
- reviewed but not executable;
- unsupported by the current adapters;
- explicitly exempted by organization policy.

The summary must expose gaps instead of converting them into a confidence score. For example:

```text
Blocking findings:        4
Red/green evidenced:      3
Existing-suite only:      0
Unsupported:              1
Policy exemptions:        0

Automatic merge: BLOCKED
Reason: one blocking finding lacks executable evidence
```

Changed files may be attributed to requirements for traceability, but file or line coverage must not be represented as proof of behavioral completeness.

### Assurance states

The current verifier stores four internal outcomes. The external assurance model is target product work and must map existing outcomes without overstating them:

| Current outcome | Target external state |
|---|---|
| `PASS` | Verified only when coverage, integrity, full-suite, and policy requirements are all satisfied; otherwise Evidence incomplete |
| `FAIL` | Failed |
| `TAMPERED` | Tampered |
| `SKIPPED` | Monitored under permissive policy, or Evidence incomplete when verification is required |
| No reliable outcome | Inconclusive |

Use categorical states with explicit reasons:

- **Verified** — all required findings have valid red/green evidence, protected inputs are unchanged, and the full suite passed.
- **Evidence incomplete** — required findings or change surfaces lack executable evidence.
- **Monitored** — review occurred, but the repository or framework is not configured for verification.
- **Inconclusive** — flakes, infrastructure, or environment prevented a reliable result.
- **Tampered** — protected verification inputs changed.
- **Failed** — deterministic verification failed.

Only **Verified** may automatically merge, and only when organization policy permits it. Repositories using permissive skip behavior must be labelled Monitored rather than marketed or billed as verified.

## Product surface

The final product consists of five coherent surfaces:

1. **Merge gate** — required Git checks that enforce verification and organization policy.
2. **Evidence record** — finding-to-requirement-to-test traceability, sealed inputs, executions, identities, exceptions, and decision.
3. **Policy as code** — allowed author/reviewer/verifier combinations, required evidence, trusted commands, iteration limits, and human escalation.
4. **Customer-controlled runners** — agent-neutral execution using customer credentials and infrastructure.
5. **Integrations** — findings from built-in review, CodeRabbit, Git reviews, security tools, CI, and issue acceptance criteria.

The built-in reviewer remains the default findings source, so its reliability is a near-term product priority. External reviewers must feed the same normalized finding and verification protocol rather than create parallel pipelines. The built-in reviewer is a useful default, not the durable moat; the durable value is normalizing heterogeneous findings into an independently evidenced merge decision.

## Roadmap implications

### Build first

1. Complete and harden the deterministic verifier already in development.
2. Add a fail-closed Verified configuration while preserving an explicitly labelled Monitored mode.
3. Present the evidence record and coverage ledger in Git checks and the dashboard.
4. Protect existing tests and other relevant configuration from unrelated weakening.
5. Add test-adequacy signals, such as mutation sampling or assertion-strength analysis, without representing them as certainty.
6. Implement registered roles and policy-enforced separation between reviewer, verifier, and fixer identities where required.
7. Expand framework support beyond JavaScript, prioritized by customer demand; Python and Go are the first likely adapters.
8. Support fork verification without unsafe branch writes.
9. Export signed verification attestations through the API and common security tooling formats.
10. Ingest findings from external reviewers, beginning with CodeRabbit and common security scanners.
11. Make branch-protection and merge-assurance policy first-class configuration.
12. Turn the existing Docker deployment into a supported self-hosting experience.

### Expand through assurance protocols

Future automation should ship as curated change-assurance protocols, not arbitrary user-programmable loops:

- review finding to verified remediation;
- CI failure to verified repair;
- vulnerability finding to verified remediation;
- dependency update to verified compatibility;
- issue acceptance criteria to verified implementation.

Every protocol terminates in evidence or human escalation.

### Existing proactive workflows

The current Review and Fix claim types directly support the core product. Feature and Spec remain supported compatibility paths and may serve as inputs to curated assurance protocols, but they are not standalone product categories. The existing Spec-to-Build chain may evolve into issue-to-verified-implementation; it must not auto-merge without the same evidence and policy gate.

### Do not build

The following surfaces dilute the product and create direct competition with better-established platforms:

- a generic loop designer;
- an arbitrary workflow marketplace;
- a general-purpose agent SDK;
- model serving or a new model abstraction layer;
- a broad agent memory product;
- another general chat or IDE agent;
- broad code-review, SAST, or dependency-scanning parity;
- generic background-job orchestration as a marketed feature.

Loops and claims may remain internal implementation concepts. They are not the product category.

## Defensibility

The red/green mechanism alone can be copied. Durable differentiation requires a system around it:

- agent, model, and reviewer neutrality;
- customer-controlled execution;
- temporal and cryptographic independence today, plus optional policy-enforced identity separation once role-aware routing ships;
- broad language and framework coverage;
- exportable evidence provenance;
- explicit accounting for unsupported and unevidenced changes;
- organization-wide policy and branch protection;
- integrations that convert third-party findings into one assurance protocol;
- operational trust earned through open source and supported self-hosting.

The strategic objective is not to produce the most review comments. It is to become the trusted decision boundary through which autonomous software changes enter protected branches.

## Sources
Competitor sources retrieved 2026-09-07. Recheck vendor capabilities before using this comparison for a product or procurement decision.

- [Mastra product overview](https://mastra.ai/)
- [Mastra workflow overview](https://mastra.ai/docs/workflows/overview)
- [Hatchet product overview](https://hatchet.run/)
- [Hatchet workers](https://docs.hatchet.run/v1/workers)
- [CodeRabbit Agentic Change Management](https://docs.coderabbit.ai/)
- [CodeRabbit custom checks and limitations](https://docs.coderabbit.ai/pr-reviews/custom-checks)
- [CodeRabbit Autofix behavior](https://docs.coderabbit.ai/finishing-touches/autofix)
- [CodeRabbit plans and self-hosting offer](https://www.coderabbit.ai/pricing)
