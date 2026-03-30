# fluent-flow-runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `fluent-flow-runner` npm package — a lightweight CLI that connects to the Fluent Flow server via long-poll, receives review-fix claims, executes agent commands locally, and reports results.

**Architecture:** Standalone ESM package in `packages/fluent-flow-runner/`. A thin HTTP client wraps the three server endpoints (register, poll, claim). A run-loop orchestrates the lifecycle: authenticate, register session, poll for work, spawn agent process, report result, repeat. Agent commands are resolved from `agent_type` with CLI override. Graceful shutdown on SIGTERM/SIGINT deregisters the session and fails active claims.

**Tech Stack:** Node.js ESM, `node:child_process` (spawn), `node:http`/`node:https` (fetch), Vitest for tests. Zero production dependencies — uses Node built-ins only.

---

## File Structure

```
packages/fluent-flow-runner/
  package.json              — package metadata, bin entry, scripts
  bin/fluent-flow-runner.js — CLI entrypoint (parses args, calls run())
  src/
    client.js               — HTTP client: register(), poll(), reportClaim()
    commands.js             — Agent command resolution by type
    runner.js               — Main run-loop: connect, poll, execute, report
    logger.js               — Minimal structured logger (stdout JSON)
  tests/
    unit/
      client.test.js        — HTTP client tests (mocked fetch)
      commands.test.js      — Command resolution tests
      runner.test.js        — Run-loop tests (mocked client + spawn)
      cli.test.js           — CLI arg parsing tests
```

**Responsibilities:**
- `client.js` — Knows the server API. Pure HTTP. No business logic.
- `commands.js` — Maps `agent_type` to shell command string. Handles `{prompt}` template substitution and CLI `--command` override.
- `runner.js` — Orchestrates the lifecycle. Owns the poll loop, spawn, shutdown. Depends on client + commands.
- `bin/fluent-flow-runner.js` — Parses CLI args, validates required opts, calls `run()` from runner.js.
- `logger.js` — Thin wrapper: `info()`, `error()`, `debug()`. JSON to stdout. `--verbose` enables debug.

---

## Server API Reference (already implemented)

The runner calls these endpoints, all requiring `Authorization: Bearer <token>`:

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `/api/runner/register` | POST | `{ meta: { hostname, os, cwd } }` | `{ ok, session_id, status }` |
| `/api/runner/poll` | POST | `{ session_id }` | `{ work: <payload or null> }` |
| `/api/runner/claim` | POST | `{ status, repo, pr_number, attempt }` | `{ ok, claim_id, status }` |

---

## Task 0: Server-side — include agent metadata in long-poll payload

The dispatcher builds the payload for the long-poll transport but doesn't include `agent_type` or `transport_meta.command`. The runner needs these to resolve which agent command to execute.

**Files:**
- Modify: `packages/fluent-flow/src/notifications/dispatcher.js` (lines 78-126, `dispatch()`)
- Modify: `packages/fluent-flow/tests/unit/dispatcher.test.js`

- [ ] **Step 1: Write failing test in existing dispatcher test file**

Add a test to the dispatcher suite that verifies long_poll payloads include `agent_type` and `transport_command`:

```javascript
it('includes agent_type and transport command in long_poll payload', async () => {
  // Setup: DB agent with transport_meta.command
  mockGetAgentConfig.mockReturnValueOnce(null);
  mockGetAgent.mockResolvedValueOnce({
    transport: 'long_poll',
    transport_meta: { command: 'my-agent "{prompt}"' },
    agent_type: 'custom',
  });
  mockGetActiveClaim.mockResolvedValueOnce({ session_id: 5 });

  await dispatch({
    agentId: 'custom-agent',
    event: 'review_failed',
    payload: { repo: 'org/repo', prNumber: 7, message: 'fix it' },
  });

  const sentPayload = mockLongPollSend.mock.calls[0][1];
  expect(sentPayload.agentType).toBe('custom');
  expect(sentPayload.transportCommand).toBe('my-agent "{prompt}"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluent-flow && npx vitest run tests/unit/dispatcher.test.js`
Expected: FAIL — `agentType` and `transportCommand` not present in payload

- [ ] **Step 3: Update dispatch() to include agent metadata for long_poll**

In `src/notifications/dispatcher.js`, in the `dispatch()` function, after building `fullPayload` (line ~115), add agent metadata when the transport is `long_poll`:

```javascript
const fullPayload = {
  agentId,
  event,
  ...payload,
  ...(sessionId && { session_id: sessionId }),
  ...(agentConfig.delivery?.channel && { channel: agentConfig.delivery.channel }),
  ...(agentConfig.delivery?.to && { to: agentConfig.delivery.to }),
  // Include agent metadata for long_poll runners to resolve the command
  ...(agentConfig.transport === 'long_poll' && {
    agentType: agentConfig.agent_type,
    transportCommand: agentConfig.command,
  }),
};
```

Also update the DB agent config construction (line ~89) to include `agent_type`:

```javascript
if (dbAgent) {
  agentConfig = { transport: dbAgent.transport, agent_type: dbAgent.agent_type, ...dbAgent.transport_meta };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluent-flow && npx vitest run tests/unit/dispatcher.test.js`
Expected: PASS

- [ ] **Step 5: Run full server test suite**

Run: `cd packages/fluent-flow && npm test`
Expected: All 320 tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/fluent-flow/src/notifications/dispatcher.js packages/fluent-flow/tests/unit/dispatcher.test.js
git commit -m "feat: include agent_type and transport command in long-poll payload"
```

---

## Task 1: Package scaffold and logger

**Files:**
- Create: `packages/fluent-flow-runner/package.json`
- Create: `packages/fluent-flow-runner/src/logger.js`
- Create: `packages/fluent-flow-runner/tests/unit/logger.test.js`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "fluent-flow-runner",
  "version": "0.1.0",
  "description": "Lightweight CLI runner for Fluent Flow — connects agents to the review pipeline",
  "type": "module",
  "bin": {
    "fluent-flow-runner": "./bin/fluent-flow-runner.js"
  },
  "main": "src/runner.js",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "devDependencies": {
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 2: Write failing logger tests**

```javascript
// tests/unit/logger.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../../src/logger.js';

describe('logger', () => {
  let writeSpy;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('info() writes JSON with level "info" to stdout', () => {
    const log = createLogger(false);
    log.info('hello');
    expect(writeSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(output.level).toBe('info');
    expect(output.msg).toBe('hello');
    expect(output.time).toBeDefined();
  });

  it('error() writes JSON with level "error"', () => {
    const log = createLogger(false);
    log.error('fail');
    const output = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(output.level).toBe('error');
    expect(output.msg).toBe('fail');
  });

  it('debug() is silent when verbose is false', () => {
    const log = createLogger(false);
    log.debug('hidden');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('debug() writes when verbose is true', () => {
    const log = createLogger(true);
    log.debug('visible');
    const output = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(output.level).toBe('debug');
    expect(output.msg).toBe('visible');
  });

  it('accepts object payload merged into output', () => {
    const log = createLogger(false);
    log.info('start', { sessionId: 5 });
    const output = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(output.msg).toBe('start');
    expect(output.sessionId).toBe(5);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/logger.test.js`
Expected: FAIL — module not found

- [ ] **Step 4: Implement logger**

```javascript
// src/logger.js

/**
 * Minimal structured JSON logger for the runner.
 * @param {boolean} verbose — enable debug-level output
 * @returns {{ info, error, debug }}
 */
export function createLogger(verbose = false) {
  function write(level, msg, data = {}) {
    const entry = JSON.stringify({ level, msg, time: new Date().toISOString(), ...data }) + '\n';
    process.stdout.write(entry);
  }

  return {
    info: (msg, data) => write('info', msg, data),
    error: (msg, data) => write('error', msg, data),
    debug: (msg, data) => { if (verbose) write('debug', msg, data); },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/logger.test.js`
Expected: 5 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/fluent-flow-runner/package.json packages/fluent-flow-runner/src/logger.js packages/fluent-flow-runner/tests/unit/logger.test.js
git commit -m "feat(runner): scaffold package and add structured logger"
```

---

## Task 2: HTTP client

**Files:**
- Create: `packages/fluent-flow-runner/src/client.js`
- Create: `packages/fluent-flow-runner/tests/unit/client.test.js`

- [ ] **Step 1: Write failing client tests**

```javascript
// tests/unit/client.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '../../src/client.js';

describe('client', () => {
  let fetchMock;
  let client;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = createClient({
      serverUrl: 'https://flow.example.com',
      token: 'ff_testtoken',
      fetch: fetchMock,
    });
  });

  describe('register()', () => {
    it('POSTs to /api/runner/register with meta and auth header', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, session_id: 42, status: 'online' }),
      });
      const result = await client.register({ hostname: 'dev', os: 'linux' });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://flow.example.com/api/runner/register',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ff_testtoken',
          },
          body: JSON.stringify({ meta: { hostname: 'dev', os: 'linux' } }),
        })
      );
      expect(result).toEqual({ ok: true, session_id: 42, status: 'online' });
    });

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });
      await expect(client.register({})).rejects.toThrow('Register failed: 403');
    });
  });

  describe('poll()', () => {
    it('POSTs to /api/runner/poll with session_id', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ work: { event: 'review_failed', message: 'fix it' } }),
      });
      const result = await client.poll(42);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://flow.example.com/api/runner/poll',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ session_id: 42 }),
        })
      );
      expect(result).toEqual({ event: 'review_failed', message: 'fix it' });
    });

    it('returns null when work is null', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ work: null }),
      });
      const result = await client.poll(42);
      expect(result).toBeNull();
    });

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      });
      await expect(client.poll(42)).rejects.toThrow('Poll failed: 500');
    });
  });

  describe('reportClaim()', () => {
    it('POSTs to /api/runner/claim with claim data', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, claim_id: 1, status: 'completed' }),
      });
      const result = await client.reportClaim({
        status: 'completed',
        repo: 'org/repo',
        pr_number: 7,
        attempt: 1,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://flow.example.com/api/runner/claim',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'completed', repo: 'org/repo', pr_number: 7, attempt: 1 }),
        })
      );
      expect(result).toEqual({ ok: true, claim_id: 1, status: 'completed' });
    });

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      });
      await expect(client.reportClaim({ status: 'failed', repo: 'x/y', pr_number: 1, attempt: 1 }))
        .rejects.toThrow('Claim report failed: 404');
    });
  });

  describe('URL normalization', () => {
    it('strips trailing slash from serverUrl', async () => {
      const c = createClient({ serverUrl: 'https://flow.example.com/', token: 't', fetch: fetchMock });
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, session_id: 1, status: 'online' }) });
      await c.register({});
      expect(fetchMock.mock.calls[0][0]).toBe('https://flow.example.com/api/runner/register');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/client.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement client**

```javascript
// src/client.js

/**
 * HTTP client for the Fluent Flow runner API.
 * Wraps the three runner endpoints: register, poll, reportClaim.
 *
 * @param {object} opts
 * @param {string} opts.serverUrl — Fluent Flow server base URL
 * @param {string} opts.token — Agent token (ff_...)
 * @param {Function} [opts.fetch] — fetch implementation (default: globalThis.fetch)
 * @returns {{ register, poll, reportClaim }}
 */
export function createClient({ serverUrl, token, fetch: fetchFn = globalThis.fetch }) {
  const base = serverUrl.replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  async function post(path, body) {
    const res = await fetchFn(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${path.split('/').pop().replace(/^/, '')} failed: ${res.status}${text ? ` — ${text}` : ''}`);
    }
    return res.json();
  }

  return {
    /**
     * Register a session with the server.
     * @param {object} meta — { hostname, os, cwd }
     * @returns {Promise<{ ok, session_id, status }>}
     */
    register: (meta) => post('/api/runner/register', { meta }),

    /**
     * Long-poll for work.
     * @param {number} sessionId
     * @returns {Promise<object|null>} — claim payload or null
     */
    poll: async (sessionId) => {
      const data = await post('/api/runner/poll', { session_id: sessionId });
      return data.work ?? null;
    },

    /**
     * Report a claim result back to the server.
     * @param {object} claim — { status, repo, pr_number, attempt }
     * @returns {Promise<{ ok, claim_id, status }>}
     */
    reportClaim: (claim) => post('/api/runner/claim', claim),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/client.test.js`
Expected: 7 tests PASS

- [ ] **Step 5: Fix error messages to match test expectations**

The `post()` helper builds error messages from the path. The tests expect:
- `register` → `"Register failed: 403"`
- `poll` → `"Poll failed: 500"`
- `reportClaim` → `"Claim report failed: 404"`

Update the `post()` helper to accept a label parameter:

```javascript
async function post(path, body, label) {
  const res = await fetchFn(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${label} failed: ${res.status}${text ? ` — ${text}` : ''}`);
  }
  return res.json();
}

return {
  register: (meta) => post('/api/runner/register', { meta }, 'Register'),
  poll: async (sessionId) => {
    const data = await post('/api/runner/poll', { session_id: sessionId }, 'Poll');
    return data.work ?? null;
  },
  reportClaim: (claim) => post('/api/runner/claim', claim, 'Claim report'),
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/client.test.js`
Expected: 7 tests PASS

- [ ] **Step 7: Commit**

```bash
git add packages/fluent-flow-runner/src/client.js packages/fluent-flow-runner/tests/unit/client.test.js
git commit -m "feat(runner): add HTTP client for server API"
```

---

## Task 3: Agent command resolution

**Files:**
- Create: `packages/fluent-flow-runner/src/commands.js`
- Create: `packages/fluent-flow-runner/tests/unit/commands.test.js`

- [ ] **Step 1: Write failing command tests**

```javascript
// tests/unit/commands.test.js
import { describe, it, expect } from 'vitest';
import { resolveCommand, AGENT_COMMANDS } from '../../src/commands.js';

describe('commands', () => {
  describe('AGENT_COMMANDS', () => {
    it('has entries for claude-code, codex, and aider', () => {
      expect(AGENT_COMMANDS['claude-code']).toBeDefined();
      expect(AGENT_COMMANDS['codex']).toBeDefined();
      expect(AGENT_COMMANDS['aider']).toBeDefined();
    });
  });

  describe('resolveCommand()', () => {
    it('returns claude-code command with prompt substituted', () => {
      const cmd = resolveCommand({ agentType: 'claude-code', prompt: 'fix the bug' });
      expect(cmd).toContain('claude');
      expect(cmd).toContain('fix the bug');
      expect(cmd).toContain('--allowedTools');
    });

    it('returns codex command with prompt substituted', () => {
      const cmd = resolveCommand({ agentType: 'codex', prompt: 'fix it' });
      expect(cmd).toContain('codex');
      expect(cmd).toContain('fix it');
      expect(cmd).toContain('--approval-mode full-auto');
    });

    it('returns aider command with prompt substituted', () => {
      const cmd = resolveCommand({ agentType: 'aider', prompt: 'fix it' });
      expect(cmd).toContain('aider');
      expect(cmd).toContain('fix it');
      expect(cmd).toContain('--yes');
    });

    it('uses CLI override when provided', () => {
      const cmd = resolveCommand({
        agentType: 'claude-code',
        prompt: 'do stuff',
        commandOverride: 'my-agent --auto "{prompt}"',
      });
      expect(cmd).toBe('my-agent --auto "do stuff"');
    });

    it('uses transport_meta.command when provided (no CLI override)', () => {
      const cmd = resolveCommand({
        agentType: 'custom',
        prompt: 'hello',
        transportCommand: 'custom-tool -p "{prompt}"',
      });
      expect(cmd).toBe('custom-tool -p "hello"');
    });

    it('CLI override takes precedence over transport_meta.command', () => {
      const cmd = resolveCommand({
        agentType: 'custom',
        prompt: 'hello',
        transportCommand: 'transport-cmd "{prompt}"',
        commandOverride: 'override-cmd "{prompt}"',
      });
      expect(cmd).toBe('override-cmd "hello"');
    });

    it('throws for unknown agent_type with no override or transport command', () => {
      expect(() => resolveCommand({ agentType: 'unknown', prompt: 'x' }))
        .toThrow('No command template for agent type "unknown"');
    });

    it('escapes double quotes in prompt', () => {
      const cmd = resolveCommand({ agentType: 'claude-code', prompt: 'fix "this" bug' });
      expect(cmd).toContain('fix \\"this\\" bug');
      expect(cmd).not.toContain('fix "this" bug');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/commands.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement commands**

```javascript
// src/commands.js

/**
 * Agent command templates by agent_type.
 * {prompt} is replaced with the escaped review feedback.
 */
export const AGENT_COMMANDS = {
  'claude-code': 'claude -p "{prompt}" --allowedTools "Read,Edit,Bash,Write,Glob,Grep" --output-format json',
  'codex': 'codex --quiet --approval-mode full-auto -p "{prompt}"',
  'aider': 'aider --yes --message "{prompt}"',
};

/**
 * Escape double quotes in a string for safe shell embedding.
 * @param {string} str
 * @returns {string}
 */
function escapeQuotes(str) {
  return str.replace(/"/g, '\\"');
}

/**
 * Resolve the shell command to execute for a work item.
 *
 * Priority: commandOverride (CLI --command) > transportCommand (transport_meta.command) > AGENT_COMMANDS[agentType]
 *
 * @param {object} opts
 * @param {string} opts.agentType — e.g. "claude-code", "codex", "aider", "custom"
 * @param {string} opts.prompt — the review feedback message
 * @param {string} [opts.commandOverride] — CLI --command flag
 * @param {string} [opts.transportCommand] — transport_meta.command from server
 * @returns {string} — resolved shell command
 */
export function resolveCommand({ agentType, prompt, commandOverride, transportCommand }) {
  const template = commandOverride ?? transportCommand ?? AGENT_COMMANDS[agentType];
  if (!template) {
    throw new Error(`No command template for agent type "${agentType}"`);
  }
  return template.replace(/\{prompt\}/g, escapeQuotes(prompt));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/commands.test.js`
Expected: 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/fluent-flow-runner/src/commands.js packages/fluent-flow-runner/tests/unit/commands.test.js
git commit -m "feat(runner): add agent command resolution"
```

---

## Task 4: Main run-loop

**Files:**
- Create: `packages/fluent-flow-runner/src/runner.js`
- Create: `packages/fluent-flow-runner/tests/unit/runner.test.js`

This is the core module. It orchestrates: register session, poll loop, execute agent, report result, shutdown.

- [ ] **Step 1: Write failing runner tests**

```javascript
// tests/unit/runner.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args) => mockSpawn(...args),
}));

import { createRunner } from '../../src/runner.js';

function makeClient(overrides = {}) {
  return {
    register: vi.fn().mockResolvedValue({ ok: true, session_id: 1, status: 'online' }),
    poll: vi.fn().mockResolvedValue(null),
    reportClaim: vi.fn().mockResolvedValue({ ok: true, claim_id: 1, status: 'completed' }),
    ...overrides,
  };
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Helper: create a fake child process that exits with given code */
function fakeProcess(exitCode = 0) {
  const handlers = {};
  const proc = {
    on: vi.fn((event, cb) => { handlers[event] = cb; }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    pid: 1234,
  };
  // Auto-emit 'close' on next tick
  setTimeout(() => handlers.close?.(exitCode), 10);
  return proc;
}

describe('runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createRunner()', () => {
    it('returns an object with start() and shutdown()', () => {
      const runner = createRunner({
        client: makeClient(),
        log: makeLogger(),
        resolveCommand: vi.fn(),
      });
      expect(typeof runner.start).toBe('function');
      expect(typeof runner.shutdown).toBe('function');
    });
  });

  describe('start()', () => {
    it('registers a session on start', async () => {
      const client = makeClient();
      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn(),
        meta: { hostname: 'test' },
      });
      // Start and immediately shutdown to avoid infinite loop
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      runner.shutdown();
      await startPromise;
      expect(client.register).toHaveBeenCalledWith({ hostname: 'test' });
    });

    it('polls after registration', async () => {
      const client = makeClient();
      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn(),
      });
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      runner.shutdown();
      await startPromise;
      expect(client.poll).toHaveBeenCalledWith(1);
    });
  });

  describe('work execution', () => {
    it('executes agent command when work is received', async () => {
      const work = {
        event: 'review_failed',
        message: 'Fix the bug at src/index.js:5',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 1,
        agentId: 'claude-dev',
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          if (pollCount === 1) return work;
          return null;
        }),
      });

      mockSpawn.mockReturnValueOnce(fakeProcess(0));

      const resolveCmd = vi.fn().mockReturnValue('claude -p "Fix the bug"');

      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: resolveCmd,
        cwd: '/repo',
      });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      runner.shutdown();
      await startPromise;

      expect(resolveCmd).toHaveBeenCalledWith(expect.objectContaining({
        prompt: 'Fix the bug at src/index.js:5',
      }));
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cwd: '/repo', shell: true }),
      );
    });

    it('reports completed when agent exits 0', async () => {
      const work = {
        event: 'review_failed',
        message: 'Fix it',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 1,
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      mockSpawn.mockReturnValueOnce(fakeProcess(0));

      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn().mockReturnValue('echo ok'),
      });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      runner.shutdown();
      await startPromise;

      expect(client.reportClaim).toHaveBeenCalledWith({
        status: 'completed',
        repo: 'org/repo',
        pr_number: 7,
        attempt: 1,
      });
    });

    it('reports failed when agent exits non-zero', async () => {
      const work = {
        event: 'review_failed',
        message: 'Fix it',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 1,
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      mockSpawn.mockReturnValueOnce(fakeProcess(1));

      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn().mockReturnValue('echo fail'),
      });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      runner.shutdown();
      await startPromise;

      expect(client.reportClaim).toHaveBeenCalledWith({
        status: 'failed',
        repo: 'org/repo',
        pr_number: 7,
        attempt: 1,
      });
    });
  });

  describe('shutdown()', () => {
    it('stops the poll loop', async () => {
      const client = makeClient();
      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn(),
      });
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      runner.shutdown();
      await startPromise;
      const pollCountAtShutdown = client.poll.mock.calls.length;
      await new Promise((r) => setTimeout(r, 100));
      expect(client.poll.mock.calls.length).toBe(pollCountAtShutdown);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/runner.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement runner**

```javascript
// src/runner.js
import { spawn } from 'node:child_process';
import { hostname, platform } from 'node:os';

/**
 * Create a runner instance.
 *
 * @param {object} opts
 * @param {object} opts.client — createClient() instance
 * @param {object} opts.log — createLogger() instance
 * @param {Function} opts.resolveCommand — resolveCommand() from commands.js
 * @param {string} [opts.cwd] — working directory for agent commands
 * @param {object} [opts.meta] — session metadata override
 * @returns {{ start, shutdown }}
 */
export function createRunner({ client, log, resolveCommand, cwd, meta }) {
  let running = false;
  let sessionId = null;
  let activeWork = null;
  let activeProcess = null;

  const sessionMeta = meta ?? {
    hostname: hostname(),
    os: platform(),
    ...(cwd && { cwd }),
  };

  /**
   * Execute an agent command and return the exit code.
   * @param {string} command — full shell command
   * @returns {Promise<number>} exit code
   */
  function execute(command) {
    return new Promise((resolve, reject) => {
      log.info('Executing agent command', { command });

      // Use shell: true so the command string is interpreted by the shell.
      // Split on first space only for spawn(cmd, args, opts) compatibility isn't needed —
      // shell: true passes the whole string to the shell.
      const proc = spawn(command, [], {
        cwd: cwd ?? process.cwd(),
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      activeProcess = proc;

      proc.stdout.on('data', (data) => {
        log.debug('agent:stdout', { data: data.toString().trimEnd() });
      });

      proc.stderr.on('data', (data) => {
        log.debug('agent:stderr', { data: data.toString().trimEnd() });
      });

      proc.on('close', (code) => {
        activeProcess = null;
        resolve(code ?? 1);
      });

      proc.on('error', (err) => {
        activeProcess = null;
        reject(err);
      });
    });
  }

  /**
   * Handle a single work item: resolve command, execute, report result.
   * @param {object} work — claim payload from the server
   */
  async function handleWork(work) {
    activeWork = work;
    const { message, repo, prNumber, attempt, agentId } = work;

    log.info('Work received', { repo, prNumber, attempt, event: work.event });

    let command;
    try {
      command = resolveCommand({
        agentType: work.agentType ?? 'claude-code',
        prompt: message,
        transportCommand: work.transportCommand,
      });
    } catch (err) {
      log.error('Failed to resolve command', { error: err.message });
      await client.reportClaim({ status: 'failed', repo, pr_number: prNumber, attempt });
      activeWork = null;
      return;
    }

    let exitCode;
    try {
      exitCode = await execute(command);
    } catch (err) {
      log.error('Agent process error', { error: err.message });
      exitCode = 1;
    }

    const status = exitCode === 0 ? 'completed' : 'failed';
    log.info('Agent finished', { repo, prNumber, attempt, exitCode, status });

    try {
      await client.reportClaim({ status, repo, pr_number: prNumber, attempt });
    } catch (err) {
      log.error('Failed to report claim', { error: err.message });
    }

    activeWork = null;
  }

  return {
    /**
     * Start the runner. Registers a session and enters the poll loop.
     * Resolves when shutdown() is called.
     */
    async start() {
      running = true;

      log.info('Registering session...');
      const session = await client.register(sessionMeta);
      sessionId = session.session_id;
      log.info('Session registered', { sessionId, status: session.status });

      while (running) {
        try {
          const work = await client.poll(sessionId);
          if (work) {
            await handleWork(work);
          }
        } catch (err) {
          if (!running) break;
          log.error('Poll error', { error: err.message });
          // Brief backoff on error before retrying
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      log.info('Runner stopped');
    },

    /**
     * Gracefully shut down. Kills active agent process if any.
     */
    shutdown() {
      log.info('Shutting down...');
      running = false;
      if (activeProcess) {
        activeProcess.kill('SIGTERM');
      }
    },

    /** Expose for testing */
    get sessionId() { return sessionId; },
    get activeWork() { return activeWork; },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/runner.test.js`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/fluent-flow-runner/src/runner.js packages/fluent-flow-runner/tests/unit/runner.test.js
git commit -m "feat(runner): add main run-loop with poll, execute, report"
```

---

## Task 5: CLI entrypoint

**Files:**
- Create: `packages/fluent-flow-runner/bin/fluent-flow-runner.js`
- Create: `packages/fluent-flow-runner/tests/unit/cli.test.js`

- [ ] **Step 1: Write failing CLI tests**

```javascript
// tests/unit/cli.test.js
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../bin/fluent-flow-runner.js';

describe('CLI parseArgs()', () => {
  it('parses --token and --server', () => {
    const opts = parseArgs(['--token', 'ff_abc', '--server', 'https://flow.example.com']);
    expect(opts.token).toBe('ff_abc');
    expect(opts.server).toBe('https://flow.example.com');
  });

  it('parses --command override', () => {
    const opts = parseArgs(['--token', 't', '--server', 's', '--command', 'my-agent "{prompt}"']);
    expect(opts.command).toBe('my-agent "{prompt}"');
  });

  it('parses --cwd', () => {
    const opts = parseArgs(['--token', 't', '--server', 's', '--cwd', '/repos/myapp']);
    expect(opts.cwd).toBe('/repos/myapp');
  });

  it('parses --verbose', () => {
    const opts = parseArgs(['--token', 't', '--server', 's', '--verbose']);
    expect(opts.verbose).toBe(true);
  });

  it('defaults verbose to false', () => {
    const opts = parseArgs(['--token', 't', '--server', 's']);
    expect(opts.verbose).toBe(false);
  });

  it('throws if --token is missing', () => {
    expect(() => parseArgs(['--server', 's'])).toThrow('--token is required');
  });

  it('throws if --server is missing', () => {
    expect(() => parseArgs(['--token', 't'])).toThrow('--server is required');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/cli.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement CLI entrypoint**

```javascript
#!/usr/bin/env node
// bin/fluent-flow-runner.js

import { createClient } from '../src/client.js';
import { resolveCommand } from '../src/commands.js';
import { createRunner } from '../src/runner.js';
import { createLogger } from '../src/logger.js';

/**
 * Parse CLI arguments into an options object.
 * @param {string[]} argv — process.argv.slice(2) equivalent
 * @returns {object}
 */
export function parseArgs(argv) {
  const opts = { verbose: false };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--token':    opts.token = argv[++i]; break;
      case '--server':   opts.server = argv[++i]; break;
      case '--command':  opts.command = argv[++i]; break;
      case '--cwd':      opts.cwd = argv[++i]; break;
      case '--verbose':  opts.verbose = true; break;
    }
  }

  if (!opts.token) throw new Error('--token is required');
  if (!opts.server) throw new Error('--server is required');

  return opts;
}

/**
 * Main entry point. Only runs when executed directly (not imported for testing).
 */
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}\n\nUsage: fluent-flow-runner --token <token> --server <url> [--command <cmd>] [--cwd <path>] [--verbose]`);
    process.exit(1);
  }

  const log = createLogger(opts.verbose);
  const client = createClient({ serverUrl: opts.server, token: opts.token });
  const runner = createRunner({
    client,
    log,
    resolveCommand: (cmdOpts) => resolveCommand({ ...cmdOpts, commandOverride: opts.command }),
    cwd: opts.cwd,
  });

  const shutdown = () => runner.shutdown();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    await runner.start();
  } catch (err) {
    log.error('Runner failed', { error: err.message });
    process.exit(1);
  }
}

// Run main only when executed directly
const isDirectRun = process.argv[1]?.endsWith('fluent-flow-runner.js') && !process.env.VITEST;
if (isDirectRun) {
  main();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/cli.test.js`
Expected: 7 tests PASS

- [ ] **Step 5: Run all runner tests together**

Run: `cd packages/fluent-flow-runner && npx vitest run`
Expected: All tests pass (logger: 5, client: 7, commands: 8, runner: 6, cli: 7 = ~33 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/fluent-flow-runner/bin/fluent-flow-runner.js packages/fluent-flow-runner/tests/unit/cli.test.js
git commit -m "feat(runner): add CLI entrypoint with arg parsing and signal handling"
```

---

## Task 6: Install dependencies and verify full build

**Files:**
- Modify: `packages/fluent-flow-runner/package.json` (if needed)

- [ ] **Step 1: Install dependencies from monorepo root**

Run: `npm install`

This adds `packages/fluent-flow-runner` to the workspace and installs vitest as a devDependency.

- [ ] **Step 2: Run all runner tests via npm script**

Run: `cd packages/fluent-flow-runner && npm test`
Expected: All ~33 tests pass

- [ ] **Step 3: Run full monorepo test suite**

Run: `npm test` (from monorepo root)
Expected: Both packages pass — fluent-flow (320 tests) + fluent-flow-runner (~33 tests)

- [ ] **Step 4: Verify npx dry-run works**

Run: `cd packages/fluent-flow-runner && node bin/fluent-flow-runner.js`
Expected: Error printed: `Error: --token is required` followed by usage text, exit code 1

- [ ] **Step 5: Commit if any adjustments were needed**

```bash
git add -A
git commit -m "chore(runner): finalize package setup and verify build"
```

---

## Task 7: Breaking-change verification (TDD step 4)

Per the TDD workflow: verify code behavior by introducing a real-world breaking change, confirm tests catch it, then revert.

- [ ] **Step 1: Break client — change register endpoint path**

In `src/client.js`, change `/api/runner/register` to `/api/runner/signup`. Run tests:
```
cd packages/fluent-flow-runner && npx vitest run tests/unit/client.test.js
```
Expected: register tests FAIL (URL mismatch)

- [ ] **Step 2: Revert the breaking change**

Undo the path change. Run tests:
Expected: All PASS

- [ ] **Step 3: Break commands — remove quote escaping**

In `src/commands.js`, change `escapeQuotes()` to return `str` unmodified. Run tests:
```
cd packages/fluent-flow-runner && npx vitest run tests/unit/commands.test.js
```
Expected: "escapes double quotes in prompt" test FAILS

- [ ] **Step 4: Revert the breaking change**

Undo. Run tests:
Expected: All PASS

- [ ] **Step 5: Break runner — report wrong status on exit code 0**

In `src/runner.js`, change `exitCode === 0 ? 'completed' : 'failed'` to `'failed'`. Run tests:
```
cd packages/fluent-flow-runner && npx vitest run tests/unit/runner.test.js
```
Expected: "reports completed when agent exits 0" FAILS

- [ ] **Step 6: Revert the breaking change**

Undo. Run full suite:
```
cd packages/fluent-flow-runner && npx vitest run
```
Expected: All ~33 tests PASS

---

## Summary

| Task | What | Tests |
|---|---|---|
| 0 | Server-side: agent metadata in long-poll payload | 1 (+ existing) |
| 1 | Package scaffold + logger | 5 |
| 2 | HTTP client (register, poll, reportClaim) | 7 |
| 3 | Agent command resolution | 8 |
| 4 | Main run-loop | 6 |
| 5 | CLI entrypoint | 7 |
| 6 | Install + full build verification | 0 (integration) |
| 7 | Breaking-change verification | 0 (TDD validation) |
| **Total** | | **~34 new tests** |

After completing all tasks, the runner is ready for dogfooding: register an agent with `transport: 'long_poll'` in the admin API, generate a token, and run `npx fluent-flow-runner --token <token> --server http://flow.fluenthive.io`.
