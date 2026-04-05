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
   * Accepts either { bin, args } (no shell) or { shell } (custom template).
   * @param {{ bin: string, args: string[] } | { shell: string }} cmd
   * @returns {Promise<number>} exit code
   */
  function execute(cmd) {
    return new Promise((resolve, reject) => {
      log.info('Executing agent command', { command: cmd.shell ?? cmd.bin });

      const proc = cmd.shell
        ? spawn(cmd.shell, [], { cwd: cwd ?? process.cwd(), shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(cmd.bin, cmd.args, { cwd: cwd ?? process.cwd(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });

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
    const { message, repo, attempt } = work;
    const prNumber = work.prNumber ?? work.pr_number;

    log.info('Work received', { repo, prNumber, attempt, event: work.event });

    let cmd;
    try {
      cmd = resolveCommand({
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
      exitCode = await execute(cmd);
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
          } else {
            // Server returned no work (poll timeout). Brief pause before reconnect.
            await new Promise((r) => setTimeout(r, 100));
          }
        } catch (err) {
          if (!running) break;
          log.error('Poll error', { error: err.message });
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      log.info('Runner stopped');
    },

    /**
     * Gracefully shut down. Kills active agent process, reports active claim as failed.
     */
    async shutdown() {
      log.info('Shutting down...');
      running = false;
      if (activeProcess) {
        activeProcess.kill('SIGTERM');
      }
      // Best-effort: report active claim as failed so the server doesn't wait for timeout
      if (activeWork) {
        const { repo, attempt } = activeWork;
        const prNumber = activeWork.prNumber ?? activeWork.pr_number;
        try {
          await client.reportClaim({ status: 'failed', repo, pr_number: prNumber, attempt });
          log.info('Reported active claim as failed on shutdown', { repo, prNumber, attempt });
        } catch (err) {
          log.error('Failed to report claim on shutdown', { error: err.message });
        }
      }
    },

    /** Expose for testing */
    get sessionId() { return sessionId; },
    get activeWork() { return activeWork; },
  };
}
