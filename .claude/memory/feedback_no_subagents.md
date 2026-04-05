---
name: No subagent execution
description: Avoid subagent-driven development - use inline execution instead to prevent resource exhaustion
type: feedback
---

Do not use subagent-driven development for plan execution. Victor's machine crashes from the resource usage. Use inline execution (executing-plans skill) instead.

**Why:** Multiple parallel subagents consume too much memory/CPU on Victor's Windows machine.
**How to apply:** When executing implementation plans, always use inline execution. Never suggest or use superpowers:subagent-driven-development.
