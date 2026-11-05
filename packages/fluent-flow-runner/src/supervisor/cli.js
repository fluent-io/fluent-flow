import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { connectSupervisor, SupervisorRequestError } from './client.js';


export const LOCAL_ANSWER_WARNING = 'Your answer is sent to the selected tool and model and may be stored in their conversation history.';
export const LOCAL_TTY_REQUIRED = 'Local answers require an interactive terminal.';
const REQUEST_UNAVAILABLE = 'This request is no longer available. Refresh the session.';
const INVALID_ANSWER = 'This request does not accept these answers.';
const RESULT_COPY = {
  request_unavailable: REQUEST_UNAVAILABLE,
  invalid_response: INVALID_ANSWER,
  answer_on_host: 'Answer this request on the execution host.',
  reconciling: 'Execution status is uncertain. Review recovery before continuing.',
};
const CONFIG_UNREADABLE = 'The saved connector configuration could not be read.';
const SUPERVISOR_UNAVAILABLE = 'The runner is not running on this host. Start it, then try again.';
const CHOOSE_REQUEST = 'Several questions are waiting. Choose one with --request <id>:';
const NOT_SENT = 'No answer was sent.';
const SENT = 'Answer sent.';

class AnswerAborted extends Error {
  constructor() {
    super('local answer input cancelled');
    this.name = 'AnswerAborted';
  }
}

function readMasked(input, output, prompt) {
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (settle) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      settle();
    };
    function onData(chunk) {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return finish(() => resolve(value));
        if (ch === '\u0003' || ch === '\u0004') return finish(() => reject(new AnswerAborted()));
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = [...value].slice(0, -1).join('');
            output.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        output.write('*');
      }
    }
    output.write(prompt);
    input.setRawMode(true);
    input.setEncoding?.('utf8');
    input.on('data', onData);
    input.resume();
  });
}

export function savedInstance(configFile) {
  const parsed = JSON.parse(readFileSync(configFile, 'utf8'));
  const instanceId = parsed?.instanceId;
  if (typeof instanceId !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(instanceId)) throw new TypeError('instanceId missing or invalid');
  return { instanceId, stateDir: join(dirname(configFile), `connector-${instanceId}`) };
}

async function readSelections(input, output, question) {
  const say = (line) => output.write(`${line}\n`);
  say(`${question.header}: ${question.question}`);
  let selected = [];
  if (question.options?.length) {
    question.options.forEach((option, i) => say(`  ${i + 1}. ${option.label}${option.description ? ` (${option.description})` : ''}`));
    const hint = question.multiSelect ? 'numbers separated by commas' : 'one number';
    const raw = (await readMasked(input, output, `Choose ${hint}${question.allowOther ? ', or press Enter to skip' : ''}: `)).trim();
    if (raw !== '') {
      const picks = raw.split(',').map((part) => Number.parseInt(part.trim(), 10));
      if (picks.some((n) => !Number.isSafeInteger(n) || n < 1 || n > question.options.length)) return null;
      selected = [...new Set(picks)].map((n) => question.options[n - 1].label);
      if (!question.multiSelect && selected.length > 1) return null;
    }
  }
  let other;
  if (question.allowOther) {
    const typed = await readMasked(input, output, question.options?.length ? 'Other answer (press Enter to skip): ' : 'Answer: ');
    if (typed !== '') other = typed;
  }
  if (selected.length === 0 && other === undefined) return null;
  return other === undefined ? { selected } : { selected, other };
}

/**
 * @param {{ configFile?: string, instance?: { instanceId: string, stateDir: string }, requestId?: string, input: any, output: any, connect?: typeof connectSupervisor, randomId?: () => string }} opts
 * @returns {Promise<number>} the process exit code
 */
export async function runLocalAnswer({ configFile, instance: known, requestId, input, output, connect = connectSupervisor, randomId = randomUUID }) {
  const say = (line) => output.write(`${line}\n`);
  if (!input?.isTTY || typeof input.setRawMode !== 'function') {
    say(LOCAL_TTY_REQUIRED);
    return 1;
  }
  let instance = known;
  try {
    instance ??= savedInstance(configFile);
  } catch {
    say(CONFIG_UNREADABLE);
    return 1;
  }
  let client;
  try {
    client = await connect({ instanceId: instance.instanceId, stateDir: instance.stateDir, role: 'cli' });
  } catch {
    say(SUPERVISOR_UNAVAILABLE);
    return 1;
  }
  try {
    const { requests } = await client.request('pendingQuestions', {});
    const questions = requests.filter((r) => r.kind === 'question' && Array.isArray(r.questions) && r.questions.length > 0);
    const request = requestId ? questions.find((r) => r.requestId === requestId) : questions.length === 1 ? questions[0] : null;
    if (!request) {
      if (!requestId && questions.length > 1) {
        say(CHOOSE_REQUEST);
        for (const r of questions) say(`  ${r.requestId}  ${r.questions[0].question}`);
      } else say(REQUEST_UNAVAILABLE);
      return 1;
    }
    say(LOCAL_ANSWER_WARNING);
    const selections = {};
    for (const question of request.questions) {
      const answer = await readSelections(input, output, question);
      if (!answer) {
        say(INVALID_ANSWER);
        say(NOT_SENT);
        return 1;
      }
      selections[question.id] = answer;
    }
    let result;
    try {
      result = await client.request('localAnswer', { localCommandId: randomId(), requestId: request.requestId, selections });
    } catch (err) {
      if (!(err instanceof SupervisorRequestError)) throw err;
      say(RESULT_COPY.reconciling);
      return 1;
    }
    if (result?.state === 'applied') {
      say(SENT);
      return 0;
    }
    say(RESULT_COPY[result?.errorCode] ?? RESULT_COPY.reconciling);
    return 1;
  } catch (err) {
    if (!(err instanceof AnswerAborted)) throw err;
    say(NOT_SENT);
    return 1;
  } finally {
    await client.close();
  }
}

export const SHUTDOWN_UNCERTAIN = "Shutdown could not be confirmed. Check the runner's status before continuing.";

const STOP_TIMEOUT_MS = 30_000;
const STOPPED = 'Runner stopped.';
const COMMAND_USAGE = 'Commands: status, list, stop, answer --local [--request <id>]';

function workerLine(w) {
  return `  ${w.backend}  run ${w.runId}  session ${w.sessionId}  ${w.state}  started ${w.startedAt ?? 'unknown'}${w.needsRecovery ? '  needs recovery' : ''}`;
}

/**
 * @param {{ command: string, stateDir: string, instanceId: string, options?: { timeoutMs?: number, request?: string, local?: boolean }, io: { input?: any, output: { write: (chunk: string) => unknown } }, connect?: typeof connectSupervisor }} opts
 * @returns {Promise<number>}
 */
export async function runSupervisorCommand({ command, stateDir, instanceId, options = {}, io, connect = connectSupervisor }) {
  const say = (line) => io.output.write(`${line}\n`);
  if (command === 'answer') {
    if (!options.local) {
      say(COMMAND_USAGE);
      return 1;
    }
    return runLocalAnswer({ instance: { instanceId, stateDir }, requestId: options.request, input: io.input, output: io.output, connect });
  }
  if (!['status', 'list', 'stop'].includes(command)) {
    say(COMMAND_USAGE);
    return 1;
  }
  let client;
  try {
    client = await connect({ instanceId, stateDir, role: 'cli' });
  } catch {
    if (command === 'stop') {
      say(SUPERVISOR_UNAVAILABLE);
      return 1;
    }
    say(`Instance: ${instanceId}`);
    say('Supervisor: not running');
    return 0;
  }
  try {
    if (command === 'stop') {
      const { state } = await client.request('stop', { scope: 'all', timeoutMs: options.timeoutMs ?? STOP_TIMEOUT_MS });
      if (state === 'stopped') {
        say(STOPPED);
        return 0;
      }
      say(SHUTDOWN_UNCERTAIN);
      return 1;
    }
    const status = await client.request('status', {});
    const workers = Array.isArray(status.workers) ? status.workers : [];
    if (command === 'list') {
      for (const w of workers) say(workerLine(w));
      return 0;
    }
    say(`Instance: ${instanceId}`);
    say(`Supervisor: running${status.admissionStopped ? ', admission stopped' : ''}`);
    say(`Containment: ${status.containment?.state === 'verified' ? 'verified' : 'unavailable'}`);
    say(`Capacity: ${Object.entries(status.capacity ?? {}).map(([backend, c]) => `${backend} ${c.used}/${c.limit}`).join(', ')}`);
    say(`Workers: ${workers.length}`);
    for (const w of workers) say(workerLine(w));
    return 0;
  } catch (err) {
    if (!(err instanceof SupervisorRequestError)) throw err;
    say(command === 'stop' ? SHUTDOWN_UNCERTAIN : SUPERVISOR_UNAVAILABLE);
    return 1;
  } finally {
    await client.close();
  }
}
