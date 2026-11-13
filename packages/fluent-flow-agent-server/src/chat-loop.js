import { z } from 'zod';

const MAX_SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const clocksSchema = z.object({
  maxSessionDurationMs: z.number().int().min(1).max(MAX_SESSION_DURATION_MS),
  commandPollMs: z.number().int().min(1).max(60_000),
  commandLeaseRenewMs: z.number().int().min(1).max(30_000),
  maxQueuedPrompts: z.number().int().min(1).max(64),
});

export async function runChatSession({
  runtime, client, sessionId, claimId, repo, githubTokenExpiresAt, instructions = '',
  maxSessionDurationMs = 8 * 60 * 60 * 1000, commandPollMs = 1000,
  commandLeaseRenewMs = 30_000, maxQueuedPrompts = 64, signal, failurePromise = undefined, handoff = undefined,
}) {
  instructions = z.string().max(20000).parse(instructions);
  let instructionsApplied = false;
  clocksSchema.parse({ maxSessionDurationMs, commandPollMs, commandLeaseRenewMs, maxQueuedPrompts });
  if (repo != null && !z.iso.datetime({ offset: true }).safeParse(githubTokenExpiresAt).success) {
    throw new Error('Chat credential expiry is required');
  }
  const startedAt = Date.now();
  const deadline = repo == null
    ? startedAt + maxSessionDurationMs
    : Math.min(startedAt + maxSessionDurationMs, Date.parse(githubTokenExpiresAt));
  if (deadline <= startedAt) return { status: 'cancelled', end_reason: 'max_duration' };
  if (signal?.aborted) return { status: 'failed', failure_kind: 'terminal', end_reason: 'host_lost' };
  let stopping = false;
  let settle;
  const stopped = new Promise((resolve) => { settle = resolve; });
  const controller = new AbortController();
  let turnTail = Promise.resolve();
  let cancelBarrier = Promise.resolve();
  const turns = new Set();
  const seenCommands = new Set();
  let closing;
  const close = () => {
    closing ??= Promise.resolve().then(() => runtime.close());
    return closing;
  };
  const stop = (outcome) => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    settle(outcome);
    close().catch(() => undefined);
  };
  const ack = (command, status, result) => client.ackClaimCommand(
    sessionId, claimId, command.id, status, result,
  );

  async function submit(command) {
    const previous = turnTail;
    const task = (async () => {
      let ready = false;
      while (!ready && !stopping) {
        let timer;
        const waiting = await Promise.race([
          previous.then(() => 'ready'),
          stopped.then(() => 'stopped'),
          new Promise((resolve) => { timer = setTimeout(() => resolve('renew'), commandLeaseRenewMs); }),
        ]);
        clearTimeout(timer);
        if (waiting === 'stopped') return;
        if (waiting === 'ready') ready = true;
        else {
          const renewal = await client.renewClaimCommand(sessionId, claimId, command.id);
          if (!renewal?.renewed) {
            await Promise.race([previous, stopped]);
            return;
          }
        }
      }
      if (stopping) return;
      const renewal = await client.renewClaimCommand(sessionId, claimId, command.id);
      if (!renewal?.renewed || stopping) return;
      while (!stopping) {
        const barrier = cancelBarrier;
        await Promise.race([barrier, stopped]);
        if (barrier === cancelBarrier) break;
      }
      if (stopping) return;
      let accepted = false;
      let handoffTimer;
      let handoffRenewal = Promise.resolve();
      try {
        if (command.kind === 'handoff') {
          if (repo == null || typeof handoff !== 'function') {
            await ack(command, 'failed', { code: 'handoff_unavailable' });
            return;
          }
          handoffTimer = setInterval(() => {
            handoffRenewal = handoffRenewal.then(async () => {
              if (stopping) return;
              const renewal = await client.renewClaimCommand(sessionId, claimId, command.id);
              if (!renewal?.renewed) throw new Error('Handoff command lease was lost');
            }).catch(error => { stop({ error }); });
          }, commandLeaseRenewMs);
          let result;
          try {
            result = await handoff(async () => { accepted = true; });
          } catch (error) {
            if (typeof error?.handoffCode !== 'string') throw error;
            if (!stopping) await ack(command, 'failed', { code: error.handoffCode });
            return;
          }
          await handoffRenewal;
          if (!stopping) await ack(command, 'acked', result);
          return;
        }
        const text = command.payload?.text ?? command.payload?.prompt;
        const prompt = !instructionsApplied && instructions ? `Project instructions:\n${instructions}\n\nUser message:\n${text}` : text;
        await runtime.prompt(prompt, {
          onAccepted: ({ messageId }) => {
            instructionsApplied = true;
            accepted = true;
            return ack(command, 'acked', { applied: true, messageId });
          },
        });
      } catch (error) {
        if (!accepted) await ack(command, 'uncertain', { error: 'Command outcome is uncertain' });
        throw error;
      } finally {
        clearInterval(handoffTimer);
        await handoffRenewal;
      }
    })().catch((error) => { stop({ error }); });
    turnTail = task;
    turns.add(task);
    void task.then(() => turns.delete(task));
  }

  async function poll() {
    try {
      while (!stopping) {
        let response;
        try {
          response = await client.pollClaimCommands(sessionId, claimId, { signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) return;
          throw error;
        }
        const commands = Array.isArray(response) ? response : response.commands ?? [];
        for (const command of commands) {
          if (stopping) break;
          if (seenCommands.has(command.id)) throw new Error('Chat command delivery is uncertain');
          if (seenCommands.size >= 8192) throw new Error('Chat session command limit reached');
          seenCommands.add(command.id);
          if (command.kind === 'prompt' || command.kind === 'handoff') {
            if (turns.size >= maxQueuedPrompts) {
              const renewal = await client.renewClaimCommand(sessionId, claimId, command.id);
              if (renewal?.renewed && !stopping) await ack(command, 'failed', { error: 'Session command queue is full' });
            } else await submit(command);
          } else if (command.kind === 'cancel') {
            const cancellation = new AbortController();
            cancelBarrier = new Promise(resolve => cancellation.signal.addEventListener('abort', () => resolve(undefined), { once: true }));
            try {
              const renewal = await client.renewClaimCommand(sessionId, claimId, command.id);
              if (!renewal?.renewed || stopping) continue;
              const { accepted: applied } = await runtime.cancel();
              await ack(command, 'acked', { applied });
            } finally { cancellation.abort(); }
          } else if (command.kind === 'permission' || command.kind === 'elicitation') {
            const renewal = await client.renewClaimCommand(sessionId, claimId, command.id);
            if (!renewal?.renewed || stopping) continue;
            const payload = command.payload ?? {};
            try {
              await runtime.answerRequest(command.request_key ?? command.requestKey ?? payload.requestKey, payload.answer ?? payload.response);
            } catch (error) {
              if (!/^ACP request (?:answer is invalid|is unknown or not open)$/u.test(error?.message ?? '')) throw error;
              await ack(command, 'failed', { error: 'Command was rejected' });
              continue;
            }
            await ack(command, 'acked', { applied: true });
          } else if (command.kind === 'end_session') {
            const renewal = await client.renewClaimCommand(sessionId, claimId, command.id);
            if (!renewal?.renewed || stopping) continue;
            stop({ status: 'cancelled', end_reason: 'user' });
            await close();
            await ack(command, 'acked', { applied: true });
            break;
          } else {
            await ack(command, 'failed', { error: 'Command was rejected' });
          }
        }
        if (!stopping) {
          let timer;
          await Promise.race([
            new Promise((resolve) => { timer = setTimeout(resolve, commandPollMs); }),
            stopped,
          ]);
          clearTimeout(timer);
        }
      }
    } catch (error) {
      if (stopping) throw error;
      stop({ error });
    }
  }

  failurePromise?.then((error) => stop({ error }), (error) => stop({ error }));
  let polling;
  let outcome;
  const durationTimer = setTimeout(() => stop({ status: 'cancelled', end_reason: 'max_duration' }), Math.max(0, deadline - Date.now()));
  const onAbort = () => stop({ status: 'failed', failure_kind: 'terminal', end_reason: 'host_lost' });
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    try {
      await runtime.openSession();
    } catch (error) {
      if (!stopping) throw error;
    }
    void runtime.exited.then(() => stop({ status: 'failed', failure_kind: 'terminal', end_reason: 'host_lost' }));
    polling = stopping ? Promise.resolve() : poll();
    polling.catch(() => undefined);
    outcome = await stopped;
  } finally {
    clearTimeout(durationTimer);
    signal?.removeEventListener('abort', onAbort);
    stopping = true;
    controller.abort();
    const cleanup = await Promise.allSettled([close().then(() => runtime.exited), polling, ...turns]);
    const errors = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) {
      throw Object.assign(new AggregateError(errors, 'Chat session cleanup failed'), {
        ...(outcome?.status === 'cancelled' && { chatOutcome: outcome }),
      });
    }
  }
  if (outcome.error) throw outcome.error;
  return outcome;
}
