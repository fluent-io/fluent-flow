import { execFile as execFileCb } from 'node:child_process';
import { hostname } from 'node:os';

/**
 * Runner health: pre-flight checks that the harness can actually run, and an
 * alert hook for "I can't run" conditions (missing harness, harness not
 * authenticated, gh unusable). A runner that consumes claims it cannot execute
 * silently completes them as no-ops — the worst failure mode this system has.
 */

/** Known harness binaries and how to probe them. */
const HARNESS_BINS = ['claude', 'codex', 'aider'];

function run(cmd, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    execFileCb(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: err?.message });
    });
  });
}

/**
 * Deep-probe claude-code: it exits 0 even when the run errored pre-flight
 * (e.g. "Not logged in · Please run /login"), so only the JSON result
 * envelope tells the truth. A failed auth probe costs no API tokens — it
 * errors before any request is made.
 */
async function probeClaude() {
  const res = await run('claude', ['-p', 'Reply with the single word: OK', '--output-format', 'json'], 60_000);
  if (!res.ok) {
    return { ok: false, detail: `claude exited non-zero: ${res.stderr || res.error}` };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    if (parsed?.is_error) {
      return { ok: false, detail: `claude reported an error result: ${String(parsed.result).slice(0, 200)}` };
    }
    return { ok: true, detail: 'claude responded' };
  } catch {
    return { ok: false, detail: 'claude output was not the expected JSON result envelope' };
  }
}

/**
 * Check whether this runner can execute claims at all.
 * - At least one known harness binary must exist; when `claude` is present it
 *   gets the deep auth probe (the common harness and the one that lies with
 *   exit 0).
 * - `gh` is advisory: review claims need it; the result is reported but does
 *   not gate claiming (fix claims can still run without it).
 *
 * @returns {Promise<{ healthy: boolean, harness: {ok: boolean, detail: string}, gh: {ok: boolean, detail: string} }>}
 */
export async function checkRunnerHealth() {
  const found = [];
  for (const bin of HARNESS_BINS) {
    const which = await run('which', [bin], 5_000);
    if (which.ok) found.push(bin);
  }
  if (found.length === 0) {
    return {
      healthy: false,
      harness: { ok: false, detail: `no harness binary found on PATH (looked for: ${HARNESS_BINS.join(', ')})` },
      gh: { ok: false, detail: 'not checked — no harness' },
    };
  }

  let harness = { ok: true, detail: `harnesses present: ${found.join(', ')}` };
  if (found.includes('claude')) {
    harness = await probeClaude();
  }

  const ghStatus = await run('gh', ['auth', 'status'], 15_000);
  const gh = ghStatus.ok
    ? { ok: true, detail: 'gh authenticated' }
    : { ok: false, detail: `gh auth status failed: ${ghStatus.stderr || ghStatus.error}` };

  return { healthy: harness.ok, harness, gh };
}

/**
 * Send a can't-run alert. Posts JSON to FLUENT_FLOW_ALERT_WEBHOOK_URL when
 * set (Slack/Discord-compatible {"text": ...} plus structured fields); always
 * logs at error. Never throws — alerting must not take the runner down.
 */
export async function sendAlert(reason, detail = {}) {
  const payload = {
    text: `Fluent Flow runner cannot run — ${reason}`,
    source: 'fluent-flow-runner',
    host: hostname(),
    reason,
    detail,
    time: new Date().toISOString(),
  };
  console.error(JSON.stringify({ level: 'error', msg: 'runner-alert', ...payload }));
  const url = process.env.FLUENT_FLOW_ALERT_WEBHOOK_URL;
  if (!url) return { sent: false, configured: false };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'runner-alert webhook rejected', status: res.status }));
    }
    return { sent: res.ok, configured: true };
  } catch (err) {
    // Safe to continue: alert delivery is best-effort; the error log above is
    // the durable record.
    console.error(JSON.stringify({ level: 'error', msg: 'runner-alert webhook failed', error: err.message }));
    return { sent: false, configured: true };
  }
}
