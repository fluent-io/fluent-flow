import { spawn, execFile as execFileCb } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { prepareWorktree } from './worktree.js';
import { resolvePrompt } from './prompts.js';
import { checkRunnerHealth, sendAlert } from './health.js';

/**
 * Build an isolated environment for shell commands.
 * Passes all of process.env through so agent subprocesses receive
 * API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.) and other
 * needed configuration. Command-specific env vars override.
 */
function buildCommandEnv(cmdEnv) {
  return { ...process.env, ...cmdEnv };
}

/** Default max consecutive poll failures before the runner stops. */
const DEFAULT_MAX_POLL_FAILURES = 30;

/** Base delay (ms) for exponential backoff on consecutive poll failures. */
const BASE_BACKOFF_MS = 2000;

/** Maximum backoff delay (ms). */
const MAX_BACKOFF_MS = 60000;

/** Maximum total time (ms) spent in consecutive backoff before forced exit. */
const MAX_BACKOFF_TOTAL_MS = 10 * 60 * 1000; // 10 minutes

/** Heartbeat interval (ms) while a claim executes. Env: FLUENT_FLOW_HEARTBEAT_MS. */
const DEFAULT_HEARTBEAT_MS = 60_000;

/** Hard cap on a single agent execution (ms). Env: FLUENT_FLOW_AGENT_TIMEOUT_MS. 0 disables. */
const DEFAULT_AGENT_TIMEOUT_MS = 60 * 60 * 1000;

/** Grace period (ms) between SIGTERM and SIGKILL when a process must die. */
const DEFAULT_KILL_ESCALATION_MS = 10_000;

/** Cap on buffered agent stdout (bytes) — only the tail is kept. */
const STDOUT_CAP_BYTES = 5 * 1024 * 1024;

/** Backoff delays (ms) between claim-report retries (network errors / 5xx / 429). */
const REPORT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

/** Read a non-negative numeric env var, falling back to a default. */
function numFromEnv(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/**
 * claude-code exits 0 even when the run errored pre-flight (e.g.
 * "Not logged in · Please run /login") — only the JSON result envelope tells
 * the truth. Returns the envelope when stdout is one, else null.
 */
export function parseHarnessResult(stdout) {
  try {
    const j = JSON.parse(stdout);
    if (j?.type === 'result') return j;
  } catch {
    // Not a claude JSON envelope — plain agent stdout.
  }
  return null;
}

/**
 * Create a runner instance.
 *
 * @param {object} opts
 * @param {object} opts.client — createClient() instance
 * @param {object} opts.log — createLogger() instance
 * @param {Function} opts.resolveCommand — resolveCommand() from commands.js
 * @param {string} [opts.cwd] — working directory for agent commands
 * @param {object} [opts.meta] — session metadata override
 * @param {number} [opts.maxPollFailures] — max consecutive poll failures before stopping
 * @param {number} [opts.heartbeatIntervalMs] — claim heartbeat interval (default env FLUENT_FLOW_HEARTBEAT_MS or 60s)
 * @param {number} [opts.agentTimeoutMs] — per-execution timeout (default env FLUENT_FLOW_AGENT_TIMEOUT_MS or 60min)
 * @param {number} [opts.killEscalationMs] — SIGTERM→SIGKILL grace (default 10s)
 * @returns {{ start, shutdown }}
 */
export function createRunner({
  client,
  log,
  resolveCommand,
  cwd,
  meta,
  maxPollFailures,
  heartbeatIntervalMs,
  agentTimeoutMs,
  killEscalationMs,
  healthRetryMs = 30_000,
  healthIntervalMs,
}) {
  let running = false;
  let sessionId = null;
  let activeWork = null;
  let activeProcess = null;
  let shutdownPromise = null;
  let runnerHealthy = true;
  let healthTimer = null;
  const maxFailures = maxPollFailures ?? DEFAULT_MAX_POLL_FAILURES;
  const heartbeatMs = heartbeatIntervalMs ?? numFromEnv('FLUENT_FLOW_HEARTBEAT_MS', DEFAULT_HEARTBEAT_MS);
  const agentTimeout = agentTimeoutMs ?? numFromEnv('FLUENT_FLOW_AGENT_TIMEOUT_MS', DEFAULT_AGENT_TIMEOUT_MS);
  const killEscalateMs = killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;
  const healthCheckIntervalMs = healthIntervalMs ?? numFromEnv('FLUENT_FLOW_HEALTH_INTERVAL_MS', 300_000);

  const sessionMeta = meta ?? {
    hostname: hostname(),
    os: platform(),
    ...(cwd && { cwd }),
  };

  /** Resolve the server-assigned claim id from a work payload (any casing). */
  function claimIdOf(work) {
    return work.claim_id ?? work.claimId ?? work.id ?? null;
  }

  /** Build a claim-result payload, including claim_id whenever known. */
  function claimPayload(work, status, extra = {}) {
    const payload = {
      status,
      repo: work.repo,
      pr_number: work.prNumber ?? work.pr_number ?? null,
      attempt: work.attempt,
    };
    const claimId = claimIdOf(work);
    if (claimId != null) payload.claim_id = claimId;
    return { ...payload, ...extra };
  }

  /**
   * Report a claim result with bounded retry. Retries network errors, 5xx and
   * 429; other 4xx are permanent (bad payload / already resolved) and rethrow
   * immediately so the runner doesn't wait on a dead outcome.
   */
  async function reportClaimWithRetry(payload, { delays = REPORT_RETRY_DELAYS_MS } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        return await client.reportClaim(payload);
      } catch (err) {
        lastErr = err;
        const m = /failed: (\d{3})/.exec(err.message ?? '');
        const status = m ? Number(m[1]) : null;
        if (status !== null && status < 500 && status !== 429) throw err;
        if (attempt < delays.length) {
          log.warn('Claim report failed, retrying', {
            attempt: attempt + 1,
            nextRetryMs: delays[attempt],
            httpStatus: status,
            error: err.message,
          });
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
      }
    }
    throw lastErr;
  }

  /** Terminate a process: SIGTERM, then SIGKILL after the escalation window. */
  function killProcessWithEscalation(proc, escalateMs = killEscalateMs) {
    return new Promise((resolve) => {
      if (!proc) return resolve();
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      proc.on('close', done);
      proc.on('exit', done);
      try {
        proc.kill('SIGTERM');
      } catch (e) {
        // The process is un-signallable (already dead → ESRCH, or not ours →
        // EPERM) — waiting for a close event or the SIGKILL escalation is
        // pointless. Resolve immediately.
        if (e.code !== 'ESRCH') log.warn('Failed to kill agent process', { error: e.message, code: e.code });
        done();
        return;
      }
      const escalate = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* Safe to continue: already dead */ }
      }, escalateMs);
      if (escalate.unref) escalate.unref();
      // Safety net: never wait past the escalation window even without a close event.
      const cap = setTimeout(done, escalateMs + 50);
      if (cap.unref) cap.unref();
    });
  }

  let heartbeatTimer = null;
  let heartbeatDead = false;

  /**
   * Start the claim heartbeat (session TTL + claim expiry extension) while an
   * agent executes. On 410 the session is gone — stop heartbeating but keep
   * working; the server re-dispatches via claim expiry.
   */
  function startHeartbeat(claimId) {
    if (!claimId || !client.heartbeat || heartbeatMs <= 0) return;
    heartbeatDead = false;
    heartbeatTimer = setInterval(async () => {
      if (heartbeatDead || !sessionId) return;
      try {
        await client.heartbeat(sessionId, claimId);
      } catch (err) {
        if (/failed: 410/.test(err.message ?? '')) {
          heartbeatDead = true;
          stopHeartbeat();
          log.warn('Session expired mid-claim — heartbeat stopped; server re-dispatches on expiry', { claimId });
          return;
        }
        // Safe to continue: heartbeat is advisory — the next tick retries.
        log.warn('Heartbeat failed', { claimId, error: err.message });
      }
    }, heartbeatMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }

  function stopHeartbeat() {
    heartbeatDead = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /**
   * Execute an agent command and return the result.
   * Accepts either { bin, args } (no shell) or { shell, env } (custom template).
   * Enforces a hard execution timeout (SIGTERM → SIGKILL) and caps buffered
   * stdout at STDOUT_CAP_BYTES (keeping the tail, which is what verdict
   * parsing needs).
   * @param {{ bin: string, args: string[] } | { shell: string, env?: Record<string, string> }} cmd
   * @param {string} [cwdOverride]
   * @param {number} [timeoutMs]
   * @returns {Promise<{ exitCode: number, stdout: string, timedOut?: boolean, stdoutTruncated?: boolean }>}
   */
  function execute(cmd, cwdOverride, timeoutMs = agentTimeout) {
    return new Promise((resolve, reject) => {
      log.info('Executing agent command', { command: cmd.shell ?? cmd.bin });

      const baseOpts = { cwd: cwdOverride ?? cwd ?? process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] };

      const proc = cmd.shell
        ? spawn(cmd.shell, [], {
            ...baseOpts,
            shell: true,
            env: buildCommandEnv(cmd.env),
          })
        : spawn(cmd.bin, cmd.args, { ...baseOpts, shell: false });

      activeProcess = proc;

      // Tail-capped stdout buffering — agent transcripts can exceed available
      // memory in containers; only the last STDOUT_CAP_BYTES are kept.
      const chunks = [];
      let buffered = 0;
      let truncated = false;
      const debugOn = log.isDebug ? log.isDebug() : true;
      proc.stdout.on('data', (data) => {
        chunks.push(data);
        buffered += data.length;
        while (buffered > STDOUT_CAP_BYTES && chunks.length > 1) {
          buffered -= chunks[0].length;
          chunks.shift();
          truncated = true;
        }
        if (debugOn) log.debug('agent:stdout', { data: data.toString().trimEnd() });
      });

      proc.stderr.on('data', (data) => {
        if (debugOn) log.debug('agent:stderr', { data: data.toString().trimEnd() });
      });

      // Execution timeout: SIGTERM, then SIGKILL after the escalation window.
      let timedOut = false;
      let escalateTimer = null;
      const timeoutTimer = timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            log.warn('Agent execution timed out — terminating', { timeoutMs });
            try { proc.kill('SIGTERM'); } catch { /* Safe to continue: already dead */ }
            escalateTimer = setTimeout(() => {
              try { proc.kill('SIGKILL'); } catch { /* Safe to continue: already dead */ }
            }, killEscalateMs);
            if (escalateTimer.unref) escalateTimer.unref();
          }, timeoutMs)
        : null;
      if (timeoutTimer && timeoutTimer.unref) timeoutTimer.unref();

      proc.on('close', (code) => {
        activeProcess = null;
        clearTimeout(timeoutTimer);
        clearTimeout(escalateTimer);
        const stdout = Buffer.concat(chunks).toString();
        resolve({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout,
          ...(truncated && { stdoutTruncated: true }),
          ...(timedOut && { timedOut: true }),
        });
      });

      proc.on('error', (err) => {
        activeProcess = null;
        clearTimeout(timeoutTimer);
        clearTimeout(escalateTimer);
        reject(err);
      });
    });
  }

  /**
   * Handle a single work item: resolve command, execute, report result.
   * The claim heartbeat runs for the duration; every report carries the
   * server-assigned claim_id and a failure_kind ('transient' failures are
   * re-dispatchable server-side, 'terminal'/omitted are not).
   * @param {object} work — claim payload from the server
   */
  async function handleWork(work) {
    activeWork = work;
    const claimId = claimIdOf(work);
    startHeartbeat(claimId);
    try {
      const { message, repo, attempt } = work;
      const prNumber = work.prNumber ?? work.pr_number;
      const branch = work.branch;

      log.info('Work received', { repo, prNumber, attempt, branch, event: work.event, claimId });

      // Re-authenticate gh CLI with the GitHub App token if the server provides one,
      // so reviews are posted as the GitHub App bot, not a personal account.
      if (work.githubToken) {
        try {
          await new Promise((resolve, reject) => {
            const proc = execFileCb('gh', ['auth', 'login', '--with-token'], { stdio: ['pipe', 'pipe', 'pipe'] }, (err) => {
              if (err) reject(err); else resolve();
            });
            proc.stdin.write(work.githubToken + '\n');
            proc.stdin.end();
          });
          log.info('gh CLI re-authenticated with GitHub App token');
        } catch (e) {
          log.warn('Failed to re-auth gh with GitHub App token, using fallback', { error: e.message });
        }
      }

      let cmd;
      try {
        const claimType = work.claim_type ?? work.claimType ?? 'review_fix';
        if (!work.claim_type && !work.claimType) {
          log.info('No claim_type in work payload, defaulting to review_fix');
        }
        const prompt = resolvePrompt({ claimType, work });
        if (!work.agentType) {
          throw new Error(`Work item ${repo}#${prNumber} has no agentType — server routing bug`);
        }
        cmd = resolveCommand({
          agentType: work.agentType,
          prompt,
          transportCommand: work.transportCommand,
        });
      } catch (err) {
        // Transient: environment/inputs may be fixed by a re-dispatch.
        log.error('Failed to resolve command', { error: err.message });
        await reportClaimWithRetry(claimPayload(work, 'failed', { failure_kind: 'transient' })).catch((e) => {
          log.error('Failed to report claim', { error: e.message });
        });
        return;
      }

      // Prepare worktree if branch is provided
      let worktreeCleanup = null;
      let agentCwd = cwd ?? process.cwd();
      if (branch && repo) {
        try {
          const wt = await prepareWorktree({
            workDir: cwd ?? process.cwd(),
            repo,
            prNumber,
            attempt,
            branch,
          });
          agentCwd = wt.worktreePath;
          worktreeCleanup = wt.cleanup;
          log.info('Worktree ready', { worktreePath: agentCwd });
        } catch (err) {
          // Transient: clone/auth failures are expected in container environments.
          log.error('Failed to prepare worktree', { error: err.message });
          await reportClaimWithRetry(claimPayload(work, 'failed', { failure_kind: 'transient' })).catch((e) => {
            log.error('Failed to report claim', { error: e.message });
          });
          return;
        }
      }

      let result;
      try {
        result = await execute(cmd, agentCwd);
      } catch (err) {
        // Terminal: the harness binary itself failed to spawn (e.g. ENOENT) —
        // a re-dispatch on this machine would fail identically.
        log.error('Agent process error', { error: err.message });
        result = { exitCode: 1, stdout: '' };
      }
      const { exitCode, stdout: agentOutput, timedOut } = result;

      // Always clean up worktree
      if (worktreeCleanup) {
        try {
          await worktreeCleanup();
          log.info('Worktree cleaned up');
        } catch (err) {
          log.warn('Failed to clean up worktree', { error: err.message });
        }
      }

    // claude-code exits 0 even when the run errored pre-flight — a claim that
    // "completed" without the harness ever running is a silent no-op.
    let harnessError = null;
    if (exitCode === 0) {
      const envelope = parseHarnessResult(agentOutput);
      if (envelope?.is_error) {
        harnessError = String(envelope.result ?? 'harness reported an error result').slice(0, 300);
      }
    }
    const status = harnessError ? 'failed' : (exitCode === 0 ? 'completed' : 'failed');
      const failureKind = timedOut ? 'transient' : undefined; // non-zero exits stay terminal
      log.info('Agent finished', { repo, prNumber, attempt, exitCode, status, timedOut: !!timedOut, harnessError: harnessError ?? undefined });

    if (harnessError) {
      // Terminal: harness auth/config will not fix itself on a re-dispatch —
      // alert so an operator notices instead of burning retry attempts.
      log.error('Harness reported an error result despite exit 0 — failing the claim', { repo, prNumber, attempt, detail: harnessError });
      await sendAlert('harness-error-result', { repo, prNumber, attempt, detail: harnessError });
    }

      // Parse review verdict from agent output for chaining
      let verdict;
      const claimType = work.claim_type ?? work.claimType;
      if (status === 'completed' && claimType === 'review' && agentOutput) {
        try {
          // Claude Code returns JSON with a "result" field containing the text
          const parsed = JSON.parse(agentOutput);
          const text = parsed.result ?? agentOutput;
          if (/<!--\s*reviewer-result:\s*\{\s*"status"\s*:\s*"FAIL"/i.test(text)) {
            verdict = 'fail';
            log.info('Review verdict: FAIL');
          } else if (/<!--\s*reviewer-result:/i.test(text)) {
            verdict = 'pass';
            log.info('Review verdict: PASS');
          }
        } catch {
          // Not JSON or no verdict marker — try raw text
          if (/<!--\s*reviewer-result:\s*\{\s*"status"\s*:\s*"FAIL"/i.test(agentOutput)) {
            verdict = 'fail';
            log.info('Review verdict: FAIL (raw)');
          } else if (/<!--\s*reviewer-result:/i.test(agentOutput)) {
            verdict = 'pass';
            log.info('Review verdict: PASS (raw)');
          }
        }
      }

      try {
        await reportClaimWithRetry(
          claimPayload(work, status, {
            ...(verdict && { verdict }),
            ...(failureKind && { failure_kind: failureKind }),
          }),
        );
      } catch (err) {
        log.error('Failed to report claim', { error: err.message });
      }
    } finally {
      stopHeartbeat();
      activeWork = null;
    }
  }

  /**
   * Authenticate gh CLI if GITHUB_TOKEN is set and gh is available.
   */
  async function ensureGhAuth() {
    if (!process.env.GITHUB_TOKEN) return;
    try {
      await new Promise((resolve, reject) => {
        execFileCb('gh', ['auth', 'status'], { stdio: 'pipe' }, (err) => {
          if (err) reject(err); else resolve();
        });
      });
    } catch {
      try {
        await new Promise((resolve, reject) => {
          const proc = execFileCb('gh', ['auth', 'login', '--with-token'], { stdio: ['pipe', 'pipe', 'pipe'] }, (err) => {
            if (err) reject(err); else resolve();
          });
          proc.stdin.write(process.env.GITHUB_TOKEN + '\n');
          proc.stdin.end();
        });
        log.info('gh CLI authenticated with GITHUB_TOKEN');
      } catch (e) {
        log.info('gh CLI not available or auth failed', { error: e.message });
      }
    }
  }

  /**
   * Shutdown sequence: stop heartbeats, terminate the active agent
   * (SIGTERM → SIGKILL), then report the active claim as a transient failure
   * with a bounded retry budget sized to fit inside docker stop's 10s grace.
   */
  async function doShutdown() {
    log.info('Shutting down...');
    running = false;
    stopHeartbeat();
    clearInterval(healthTimer);
    if (activeProcess) {
      const proc = activeProcess;
      activeProcess = null;
      await killProcessWithEscalation(proc, Math.min(killEscalateMs, 5000));
    }
    if (activeWork) {
      const work = activeWork;
      activeWork = null;
      try {
        await reportClaimWithRetry(claimPayload(work, 'failed', { failure_kind: 'transient' }), { delays: [1000] });
        log.info('Reported active claim as failed on shutdown', { repo: work.repo });
      } catch (err) {
        log.error('Failed to report claim on shutdown', { error: err.message });
      }
    }
  }

  return {
    /**
     * Start the runner. Registers a session and enters the poll loop.
     * Resolves when shutdown() is called.
     */
    async start() {
      running = true;

      // Health gate: never register — and so never claim — while the harness
      // cannot run. An unhealthy runner consuming claims completes them as
      // silent no-ops (the exact production failure: claude "Not logged in",
      // exit 0, claim completed, review never posted).
      let health = await checkRunnerHealth();
      if (!health.healthy) {
        log.error('Runner unhealthy — not claiming work', { harness: health.harness, gh: health.gh });
        await sendAlert('startup-health-check-failed', health);
        while (running && !(health = await checkRunnerHealth()).healthy) {
          await new Promise((r) => setTimeout(r, healthRetryMs));
        }
        if (!running) { log.info('Runner stopped before becoming healthy'); return; }
        log.info('Runner recovered — claiming work', { harness: health.harness });
        await sendAlert('recovered', { harness: health.harness });
      }

      // Periodic re-check while polling: flip to not-claiming (and alert once
      // per state change) if the harness breaks mid-run. Env:
      // FLUENT_FLOW_HEALTH_INTERVAL_MS (default 5 min, 0 disables).
      if (healthCheckIntervalMs > 0) {
        healthTimer = setInterval(async () => {
          const h = await checkRunnerHealth();
          if (!h.healthy && runnerHealthy) {
            runnerHealthy = false;
            log.error('Runner became unhealthy — pausing claim pickup', { harness: h.harness });
            await sendAlert('health-check-failed', h);
          } else if (h.healthy && !runnerHealthy) {
            runnerHealthy = true;
            log.info('Runner healthy again — resuming claim pickup', { harness: h.harness });
            await sendAlert('recovered', { harness: h.harness });
          }
        }, healthCheckIntervalMs);
        if (healthTimer.unref) healthTimer.unref();
      }

      await ensureGhAuth();

      log.info('Registering session...');
      const session = await client.register(sessionMeta);
      sessionId = session.session_id;
      log.info('Session registered', { sessionId, status: session.status });

      let consecutiveFailures = 0;
      let backoffStart = null;

      while (running) {
        if (!runnerHealthy) {
          // Unhealthy: skip claiming entirely — the session expires and the
          // server marks this runner offline instead of routing work to it.
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        try {
          const work = await client.poll(sessionId);
          consecutiveFailures = 0;
          backoffStart = null; // reset on success
          if (work) {
            await handleWork(work);
          } else {
            // Server returned no work (poll timeout). Brief pause before reconnect.
            await new Promise((r) => setTimeout(r, 100));
          }
        } catch (err) {
          if (!running) break;
          consecutiveFailures++;
          if (!backoffStart) backoffStart = Date.now();
          const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1), MAX_BACKOFF_MS);

          // Watchdog: if total backoff time exceeds threshold, force exit
          if (Date.now() - backoffStart >= MAX_BACKOFF_TOTAL_MS) {
            log.error('Watchdog: total backoff exceeded threshold, forcing exit', {
              totalBackoffMs: Date.now() - backoffStart,
              thresholdMs: MAX_BACKOFF_TOTAL_MS,
              consecutiveFailures,
            });
            process.exit(1); // Let the orchestrator restart us
          }

          log.error('Poll error', {
            error: err.message,
            consecutiveFailures,
            maxFailures,
            nextRetryMs: backoff,
          });
          // Re-register on session expiry (410) instead of retrying stale session
          if (err.message && err.message.startsWith('Poll failed: 410')) {
            log.info('Session expired, re-registering...');
            try {
              const session = await client.register(sessionMeta);
              sessionId = session.session_id;
              log.info('Re-registered', { sessionId, status: session.status });
              consecutiveFailures = 0;
              backoffStart = null; // reset watchdog window after successful re-registration
              continue; // Resume polling immediately without backoff delay
            } catch (regErr) {
              log.error('Re-registration failed', { error: regErr.message });
            }
          }
          if (consecutiveFailures >= maxFailures) {
            log.error('Max consecutive poll failures reached, stopping runner', {
              consecutiveFailures,
              maxFailures,
            });
            running = false;
            break;
          }
          await new Promise((r) => setTimeout(r, backoff));
        }
      }

      log.info('Runner stopped');
    },

    /**
     * Gracefully shut down. Kills active agent process, reports active claim as
     * failed (transient). Memoized — concurrent calls await the same shutdown;
     * resolves only after the kill and the bounded report have completed.
     */
    shutdown() {
      shutdownPromise = shutdownPromise ?? doShutdown();
      return shutdownPromise;
    },

    /** Expose for testing */
    get sessionId() { return sessionId; },
    get activeWork() { return activeWork; },
  };
}
