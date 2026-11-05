
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

function sessionFlags(args) {
  const config = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '-c') continue;
    const pair = args[i + 1];
    const eq = pair.indexOf('=');
    const value = JSON.parse(pair.slice(eq + 1));
    let node = config;
    const parts = pair.slice(0, eq).split('.');
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = value;
  }
  return config;
}

/**
 * @param {{ args: string[], cwd: string, model?: string, interruptEndsTurn?: boolean, interruptStatus?: string, mcpReady?: boolean, holdTurnStart?: boolean, threadStart?: 'ok' | 'drop' | 'error', loaded?: Array<{ id: string, cwd: string, createdAt: number }>, afterStartLoaded?: Array<{ id: string, cwd: string, createdAt: number }>, loadedPageSize?: number, unreadable?: string[], extraLayers?: any[], turnStartError?: { code: number, message: string }, steerError?: { code: number, message: string }, created?: { cwd?: string, createdAt?: number }, resumeError?: { code: number, message: string } }} opts
 */
export function createFakeCodexChild({
  args,
  cwd,
  model,
  interruptEndsTurn = true,
  interruptStatus = 'interrupted',
  mcpReady = true,
  holdTurnStart = false,
  threadStart = 'ok',
  loaded = [],
  afterStartLoaded = [],
  loadedPageSize = 2,
  unreadable = [],
  extraLayers = [],
  turnStartError,
  steerError,
  created = {},
  resumeError,
}) {
  /** @type {any[]} */
  const writes = [];
  let turnSeq = 0;
  let activeTurn = null;
  const child = /** @type {any} */ (new EventEmitter());
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 1;
  child.kill = () => {
    throw new Error('the fake child is never signalled');
  };
  const emit = (obj) => child.stdout.write(`${JSON.stringify(obj)}\n`);
  const notify = (method, params) => emit({ method, params });
  const stop = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    child.stdout.end();
    child.emit('exit', 0, null);
  };
  const flags = sessionFlags(args);
  const threadId = '01a1aa0e-0000-7000-8000-000000000001';
  /** @type {Array<{ id: string, cwd: string, createdAt: number }>} */
  const threads = [...loaded];
  const heldTurnStarts = [];
  const readyStatuses = () => {
    for (const name of ['ff_reporting', 'ff_questions']) notify('mcpServer/startupStatus/updated', { threadId: null, name, status: 'ready', error: null, failureReason: null });
  };
  const startResponse = () => ({ thread: { id: threadId, cwd }, model: model ?? flags.model, approvalPolicy: flags.approval_policy, sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: flags.sandbox_workspace_write.network_access, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });

  function startTurn() {
    activeTurn = `01a1aa0e-0000-7000-8000-00000000010${++turnSeq}`;
    notify('turn/started', { threadId, turn: { id: activeTurn, items: [], status: 'inProgress', error: null } });
    return activeTurn;
  }

  const DROP = Symbol('drop');
  const handlers = {
    initialize: () => ({ userAgent: 'fake', codexHome: '/fake' }),
    'account/read': () => ({ account: null, requiresOpenaiAuth: false }),
    'config/read': () => ({ config: {}, origins: {}, layers: [...extraLayers, { name: { type: 'sessionFlags' }, version: 'v', config: flags }] }),
    'thread/start': () => {
      if (threadStart === 'error') return { error: { code: -32603, message: 'error creating thread: fake refusal' } };
      threads.push({ id: threadId, cwd, createdAt: Math.floor(Date.now() / 1000), ...created }, ...afterStartLoaded);
      if (mcpReady) queueMicrotask(readyStatuses);
      return threadStart === 'drop' ? DROP : startResponse();
    },
    'thread/list': () => ({ data: [], nextCursor: null, backwardsCursor: null }),
    'thread/loaded/list': (params) => {
      const start = params.cursor ? Number(params.cursor) : 0;
      const size = Math.min(params.limit ?? loadedPageSize, loadedPageSize);
      const page = threads.slice(start, start + size).map((t) => t.id);
      return { data: page, nextCursor: start + size < threads.length ? String(start + size) : null };
    },
    'thread/read': (params) => {
      const t = threads.find((x) => x.id === params.threadId);
      if (!t || unreadable.includes(params.threadId)) return { error: { code: -32600, message: 'thread not found' } };
      return { thread: { ...t, status: { type: 'idle' }, turns: [] } };
    },
    'thread/resume': (params) => (resumeError ? { error: resumeError } : params.threadId === threadId ? startResponse() : { error: { code: -32600, message: 'thread not found' } }),
    'turn/start': (params, msg) => {
      if (turnStartError) return { error: turnStartError };
      if (holdTurnStart) {
        heldTurnStarts.push(msg.id);
        return DROP;
      }
      const id = activeTurn ?? startTurn();
      return { turn: { id, items: [], status: 'inProgress', error: null } };
    },
    'turn/steer': (params) => {
      if (steerError) return { error: steerError };
      if (!activeTurn) return { error: { code: -32600, message: 'no active turn to steer' } };
      if (params.expectedTurnId !== activeTurn) return { error: { code: -32600, message: `expected active turn id \`${params.expectedTurnId}\` but found \`${activeTurn}\`` } };
      return { turnId: activeTurn };
    },
    'turn/interrupt': (params) => {
      if (interruptEndsTurn) queueMicrotask(() => fake.endTurn(params.turnId, interruptStatus));
      return {};
    },
  };

  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const msg = JSON.parse(line);
        writes.push(msg);
        if (msg.method === undefined || msg.id === undefined) continue;
        const handler = handlers[msg.method];
        const reply = handler ? handler(msg.params ?? {}, msg) : { error: { code: -32601, message: 'fake: unhandled' } };
        if (reply === DROP) continue;
        if (reply && 'error' in reply) emit({ id: msg.id, error: reply.error });
        else emit({ id: msg.id, result: reply });
      }
      cb();
    },
  });
  child.stdin.on('finish', stop);

  const fake = {
    child,
    writes,
    threadId,
    emit,
    notify,
    stop,
    get activeTurn() {
      return activeTurn;
    },
    endTurn(turnId, status) {
      if (activeTurn === turnId) activeTurn = null;
      notify('turn/completed', { threadId, turn: { id: turnId, items: [], status, error: null } });
    },
    request(id, method, params) {
      emit({ id, method, params: { threadId, turnId: activeTurn, ...params } });
      return id;
    },
    readyMcp: readyStatuses,
    releaseTurnStarts() {
      for (const id of heldTurnStarts.splice(0)) {
        const turnId = activeTurn ?? startTurn();
        emit({ id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } });
      }
    },
    sent: (method) => writes.filter((w) => w.method === method),
    answers: (id) => writes.filter((w) => w.id === id && w.method === undefined),
  };
  return fake;
}
