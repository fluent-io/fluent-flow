import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'fluent-io/smoke-repo';
const BRANCH = 'smoke-branch';
const ENROLLMENT_SECRET = 'enroll_smoke_enrollment_secret_71c59e';
const DURABLE_SECRET = 'ff_smoke_durable_secret_27685c';
const PROVIDER_SECRET = 'provider-smoke-secret-630d9a';
const GITHUB_SECRETS = new Map([
  [1, 'ghp_smoke_claim_1_secret_394c'],
  [2, 'ghp_smoke_claim_2_secret_7bd2'],
  [3, 'ghp_smoke_claim_3_secret_a851'],
]);
const SECRETS = [ENROLLMENT_SECRET, DURABLE_SECRET, PROVIDER_SECRET, ...GITHUB_SECRETS.values()];
const IMAGE_MODE = process.argv.includes('--image');
const DEADLINE_MS = IMAGE_MODE ? 60_000 : 15_000;
const SHUTDOWN_DEADLINE_MS = 15_000;
const ENGINE_TIMEOUT_MS = 180_000;
const CONTAINER_UID = 1000;
const CONTAINER_USER = '1000:1000';
const CONTAINER_HEARTBEAT_MS = 75;
const CONTAINER_BASE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const CONTAINER_PATHS = {
  state: '/home/node/.fluent-flow',
  work: '/work',
  shared: '/smoke/shared',
  bin: '/smoke/bin',
  fixture: '/app/smoke/fake-acp-agent.js',
  providerSecret: '/run/secrets/provider-auth',
};
const IMAGE_TOOLS = [
  ['git', '--version'],
  ['gh', '--version'],
  ['claude-agent-acp', '--version'],
  ['codex-acp', '--version'],
];
const LISTENER_SCAN = `
const fs = require('node:fs');
const inodes = new Set();
function tolerate(error) {
  if (error.code !== 'ENOENT' && error.code !== 'EACCES' && error.code !== 'ESRCH') throw error;
}
for (const pid of fs.readdirSync('/proc').filter((name) => /^[0-9]+$/u.test(name))) {
  let descriptors = [];
  try { descriptors = fs.readdirSync('/proc/' + pid + '/fd'); } catch (error) { tolerate(error); }
  for (const descriptor of descriptors) {
    try {
      const match = /^socket:\\[([0-9]+)\\]$/u.exec(fs.readlinkSync('/proc/' + pid + '/fd/' + descriptor));
      if (match) inodes.add(match[1]);
    } catch (error) { tolerate(error); }
  }
}
const ports = new Set();
for (const [table, state] of [['tcp', '0A'], ['tcp6', '0A'], ['udp', '07'], ['udp6', '07']]) {
  for (const line of fs.readFileSync('/proc/net/' + table, 'utf8').split('\\n').slice(1).filter(Boolean)) {
    const columns = line.trim().split(/\\s+/u);
    if (columns[3] === state && inodes.has(columns[9])) ports.add(Number.parseInt(columns[1].split(':')[1], 16));
  }
}
process.stdout.write(JSON.stringify([...ports].sort((left, right) => left - right)));
`;

let livenessCheck = null;

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(label, predicate, timeoutMs = DEADLINE_MS) {
  const deadline = Date.now() + timeoutMs;
  let nextLivenessCheck = 0;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    if (livenessCheck && Date.now() >= nextLivenessCheck) {
      nextLivenessCheck = Date.now() + 1_000;
      await livenessCheck();
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(request) {
  let contents = '';
  for await (const chunk of request) {
    contents += chunk;
    ensure(Buffer.byteLength(contents, 'utf8') <= 1024 * 1024, 'Control-plane request was too large');
  }
  return contents.length === 0 ? {} : JSON.parse(contents);
}

function claim(id) {
  return {
    claim_id: id,
    claim_type: 'build',
    message: id === 1 ? 'SMOKE_CANCELLATION_ACTIVE' : `SMOKE_NORMAL_${id}`,
    repo: REPOSITORY,
    pr_number: 100 + id,
    branch: BRANCH,
    attempt: 1,
    agentType: 'smoke-agent',
    githubToken: GITHUB_SECRETS.get(id),
  };
}

async function createControlPlane({ deployment, version }) {
  const registrations = new Map();
  const sessionOrder = [];
  const currentClaimBySession = new Map();
  const sessionByClaim = new Map();
  const reports = [];
  const events = [];
  const commandPolls = new Map();
  const errors = [];
  const activeClaims = new Set();
  const runningClaims = new Set();
  const acpSessionsByClaim = new Map();
  let enrollmentInstanceId = null;
  let nextInitialClaim = 1;
  let maxActiveClaims = 0;
  let sequence = 0;
  let claim1ReleaseSequence = null;
  let claim3DeliverySequence = null;
  let allowClaim1Release = false;
  let closePromise = null;

  function mark() {
    sequence += 1;
    return sequence;
  }

  function authenticate(request, expected) {
    ensure(request.headers.authorization === `Bearer ${expected}`, 'Control-plane credential was invalid');
  }

  function knownSession(sessionId) {
    ensure(registrations.has(sessionId), 'Control-plane session was unknown');
  }

  function validateClaimSession(sessionId, claimId) {
    knownSession(sessionId);
    ensure(sessionByClaim.get(claimId) === sessionId, 'Claim was used by the wrong session');
  }

  function deliver(sessionId, claimId) {
    ensure(currentClaimBySession.get(sessionId) == null, 'A busy session polled for another claim');
    const deliverySequence = mark();
    currentClaimBySession.set(sessionId, claimId);
    sessionByClaim.set(claimId, sessionId);
    activeClaims.add(claimId);
    maxActiveClaims = Math.max(maxActiveClaims, activeClaims.size);
    if (claimId === 3) claim3DeliverySequence = deliverySequence;
    return claim(claimId);
  }

  async function handle(request, response) {
    ensure(request.method === 'POST', 'Control-plane method was invalid');
    const url = new URL(request.url ?? '/', 'http://control.local');
    const body = await readJson(request);

    if (url.pathname === '/api/agent-server/enroll') {
      authenticate(request, ENROLLMENT_SECRET);
      ensure(typeof body.instance_id === 'string' && body.instance_id.length > 0, 'Enrollment instance was invalid');
      ensure(enrollmentInstanceId === null, 'Enrollment credential was replayed');
      enrollmentInstanceId = body.instance_id;
      sendJson(response, 200, { token: DURABLE_SECRET });
      return;
    }

    authenticate(request, DURABLE_SECRET);

    if (url.pathname === '/api/agent-server/register') {
      const meta = body.meta;
      ensure(meta && typeof meta === 'object' && !Array.isArray(meta), 'Registration metadata was invalid');
      ensure(meta.runtime === 'agent-server', 'Registration runtime was invalid');
      ensure(meta.instance_id === enrollmentInstanceId, 'Registration instance was invalid');
      ensure(meta.capacity === 2, 'Registration capacity was invalid');
      ensure(meta.provider === 'claude-code', 'Registration provider was invalid');
      ensure(meta.deployment === deployment, 'Registration deployment was invalid');
      ensure(typeof meta.hostname === 'string' && meta.hostname.length > 0, 'Registration hostname was invalid');
      ensure(typeof meta.os === 'string' && meta.os.length > 0, 'Registration operating system was invalid');
      ensure(meta.version === version, 'Registration version was invalid');
      ensure(Number.isInteger(meta.slot_id) && meta.slot_id >= 0 && meta.slot_id < 2, 'Registration slot was invalid');
      ensure(Array.isArray(meta.supported_claim_types) && meta.supported_claim_types.includes('build'), 'Registration claim types were invalid');
      ensure(![...registrations.values()].some((entry) => entry.slot_id === meta.slot_id), 'Registration slot was duplicated');
      const sessionId = `smoke-control-session-${meta.slot_id + 1}`;
      ensure(!registrations.has(sessionId), 'Registration session was duplicated');
      registrations.set(sessionId, structuredClone(meta));
      sessionOrder.push(sessionId);
      currentClaimBySession.set(sessionId, null);
      mark();
      sendJson(response, 200, { session_id: sessionId, status: 'online' });
      return;
    }

    if (url.pathname === '/api/agent-server/poll') {
      knownSession(body.session_id);
      ensure(currentClaimBySession.get(body.session_id) == null, 'Poll arrived while a claim was active');
      if (nextInitialClaim <= 2) {
        const claimId = nextInitialClaim;
        nextInitialClaim += 1;
        sendJson(response, 200, { work: deliver(body.session_id, claimId) });
        return;
      }
      if (
        claim1ReleaseSequence !== null
        && claim3DeliverySequence === null
        && sessionByClaim.get(1) === body.session_id
      ) {
        sendJson(response, 200, { work: deliver(body.session_id, 3) });
        return;
      }
      mark();
      sendJson(response, 200, { work: null });
      return;
    }

    if (url.pathname === '/api/agent-server/heartbeat') {
      const claimId = body.claim_id;
      validateClaimSession(body.session_id, claimId);
      ensure(currentClaimBySession.get(body.session_id) === claimId, 'Heartbeat did not match active ownership');
      mark();
      if (
        claimId === 1
        && allowClaim1Release
        && runningClaims.has(1)
        && runningClaims.has(2)
        && claim1ReleaseSequence === null
      ) {
        activeClaims.delete(1);
        currentClaimBySession.set(body.session_id, null);
        claim1ReleaseSequence = sequence;
        sendJson(response, 200, { ok: true, claim: null });
        return;
      }
      sendJson(response, 200, { ok: true, claim: { claim_id: claimId } });
      return;
    }

    if (url.pathname === '/api/agent-server/claim') {
      const claimId = body.claim_id;
      validateClaimSession(body.session_id, claimId);
      ensure(currentClaimBySession.get(body.session_id) === claimId, 'Claim report did not match active ownership');
      reports.push(structuredClone(body));
      activeClaims.delete(claimId);
      currentClaimBySession.set(body.session_id, null);
      mark();
      sendJson(response, 200, { ok: true });
      return;
    }

    const eventsMatch = /^\/api\/agent-server\/claims\/(\d+)\/events$/u.exec(url.pathname);
    if (eventsMatch) {
      const claimId = Number(eventsMatch[1]);
      validateClaimSession(body.session_id, claimId);
      ensure(Array.isArray(body.events), 'Claim events were invalid');
      for (const event of body.events) {
        events.push({ claimId, event: structuredClone(event) });
        if (event?.kind === 'state' && event?.payload?.raw?.state === 'running') runningClaims.add(claimId);
        const acpSessionId = event?.payload?.sessionId;
        if (typeof acpSessionId === 'string') {
          const seen = acpSessionsByClaim.get(claimId) ?? new Set();
          seen.add(acpSessionId);
          acpSessionsByClaim.set(claimId, seen);
        }
      }
      mark();
      sendJson(response, 200, { ok: true });
      return;
    }

    const commandsMatch = /^\/api\/agent-server\/claims\/(\d+)\/commands\/poll$/u.exec(url.pathname);
    if (commandsMatch) {
      const claimId = Number(commandsMatch[1]);
      validateClaimSession(body.session_id, claimId);
      commandPolls.set(claimId, (commandPolls.get(claimId) ?? 0) + 1);
      mark();
      sendJson(response, 200, { commands: [] });
      return;
    }

    throw new Error('Unexpected control-plane endpoint');
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      errors.push(error);
      if (!response.headersSent) sendJson(response, 500, { error: 'Smoke control-plane request failed' });
      else response.destroy();
    });
  });

  const address = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
  ensure(address && typeof address === 'object', 'Control-plane listener address was unavailable');

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    registrations,
    sessionOrder,
    reports,
    events,
    commandPolls,
    errors,
    activeClaims,
    runningClaims,
    acpSessionsByClaim,
    get enrollmentInstanceId() { return enrollmentInstanceId; },
    get maxActiveClaims() { return maxActiveClaims; },
    get claim1ReleaseSequence() { return claim1ReleaseSequence; },
    get claim3DeliverySequence() { return claim3DeliverySequence; },
    sessionForClaim(claimId) { return sessionByClaim.get(claimId) ?? null; },
    allowRelease() { allowClaim1Release = true; },
    close() {
      if (closePromise) return closePromise;
      closePromise = new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return closePromise;
    },
  };
}

async function createFakeGit(binDir, tracePath, mode) {
  const executable = join(binDir, 'git');
  const source = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const tracePath = ${JSON.stringify(tracePath)};
const secrets = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN].filter(Boolean);
function fail(message) { process.stderr.write(message + '\\n'); process.exit(2); }
if (!process.env.GH_TOKEN || process.env.GH_TOKEN !== process.env.GITHUB_TOKEN) fail('Missing claim-scoped GitHub authentication');
const expectedHeader = 'Authorization: Basic ' + Buffer.from('x-access-token:' + process.env.GH_TOKEN, 'utf8').toString('base64');
if (process.env.GIT_CONFIG_COUNT !== '1' || process.env.GIT_CONFIG_KEY_0 !== 'http.https://github.com/.extraheader' || process.env.GIT_CONFIG_VALUE_0 !== expectedHeader) fail('Missing ephemeral Git authentication');
if (args.some((value) => secrets.some((secret) => value.includes(secret)))) fail('Git argv contained a claim credential');
if (args.some((value) => /^https?:\\/\\/[^/]*@/u.test(value))) fail('Git argv contained a credentialed remote');
function trace(operation, values = {}) { appendFileSync(tracePath, JSON.stringify({ operation, argv: args, cwd: process.cwd(), ...values }) + '\\n'); }
function originPath() { return join(process.cwd(), '.git', 'fake-origin'); }
if (args[0] === 'clone' && args.length === 3) {
  const remote = args[1];
  const target = args[2];
  mkdirSync(join(target, '.git'), { recursive: true });
  writeFileSync(join(target, '.git', 'fake-origin'), remote + '\\n');
  trace('clone', { remote, target });
} else if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
  const remote = readFileSync(originPath(), 'utf8').trim();
  trace('remote-get-url', { remote });
  process.stdout.write(remote + '\\n');
} else if (args[0] === 'remote' && args[1] === 'set-url' && args[2] === 'origin' && args.length === 4) {
  writeFileSync(originPath(), args[3] + '\\n');
  trace('remote-set-url', { remote: args[3] });
} else if (args[0] === 'fetch' && args[1] === 'origin') {
  trace('fetch', { remote: 'origin' });
} else if (args[0] === 'worktree' && args[1] === 'add') {
  const detached = args[2] === '--detach';
  const worktree = args[detached ? 3 : 2];
  mkdirSync(join(worktree, '.git'), { recursive: true });
  trace('worktree-add', { worktree });
} else if (args[0] === 'worktree' && args[1] === 'remove' && args[2]) {
  const worktree = args[2];
  rmSync(worktree, { recursive: true, force: true });
  trace('worktree-remove', { worktree });
} else {
  fail('Unsupported smoke Git operation');
}
`;
  await writeFile(executable, source, { mode });
  await chmod(executable, mode);
}

async function createFakeGh(binDir) {
  const executable = join(binDir, 'gh');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(executable, 0o700);
}

function parseJsonLines(contents) {
  return contents.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function protectedVariants() {
  return SECRETS.flatMap((secret) => [
    secret,
    Buffer.from(`x-access-token:${secret}`, 'utf8').toString('base64'),
  ]);
}

function assertNoSecrets(label, value) {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of protectedVariants()) {
    assert.equal(rendered.includes(secret), false, `${label} contained a protected value`);
  }
}

function capturedLogger(entries, bindings = {}) {
  const record = (level) => (...args) => entries.push({ level, bindings: structuredClone(bindings), args: structuredClone(args) });
  return {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    isDebug: () => false,
    child: (extra) => capturedLogger(entries, { ...bindings, ...extra }),
  };
}

async function getStatus(url, path = '/status') {
  const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(1_000) });
  ensure(response.status === 200, 'Health status endpoint was unavailable');
  return response.json();
}

function runEngine(engine, args, { timeoutMs = ENGINE_TIMEOUT_MS, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(engine, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !allowFailure) {
        reject(new Error(`${basename(engine)} ${args[0]} failed: ${String(stderr).trim() || error.message}`));
        return;
      }
      resolve({
        code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

function redact(text) {
  let redacted = text;
  for (const secret of protectedVariants()) redacted = redacted.split(secret).join('[redacted]');
  return redacted;
}

async function hostPathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function discoverFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createSocketServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function createProcessLauncher(root) {
  const [{ buildChildEnvironment }, { createHealthServer }, { createRunner }, { createAgentServer }] = await Promise.all([
    import('../src/environment.js'),
    import('../src/health-server.js'),
    import('../src/runner.js'),
    import('../src/server.js'),
  ]);
  const stateDir = join(root, 'state');
  const workDir = join(root, 'work');
  const binDir = join(root, 'bin');
  const barrierDir = join(root, 'barriers');
  const gitTracePath = join(root, 'git-trace.jsonl');
  const acpTracePath = join(root, 'acp-trace.jsonl');
  const logEntries = [];
  let agentServer = null;
  let startPromise = null;
  let healthAddress = null;
  let healthStopped = false;
  let agentStopped = false;

  async function stopAgentServer() {
    if (!agentServer || agentStopped) return;
    await agentServer.shutdown();
    if (startPromise) await startPromise;
    agentStopped = true;
  }

  return {
    expected: { deployment: 'local', version: 'smoke' },
    stateDir,
    workDir,
    barrierDir,
    gitTracePath,
    acpTracePath,
    fileMode: 0o600,
    async prepare() {
      await Promise.all([
        mkdir(workDir, { recursive: true, mode: 0o700 }),
        mkdir(barrierDir, { recursive: true, mode: 0o700 }),
        mkdir(binDir, { recursive: true, mode: 0o700 }),
      ]);
      await createFakeGit(binDir, gitTracePath, 0o700);
      await createFakeGh(binDir);
    },
    async start(controlUrl) {
      const fixturePath = fileURLToPath(new URL('../tests/unit/fake-acp-agent.js', import.meta.url));
      const safePath = [binDir, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter);
      const childEnvironment = buildChildEnvironment({
        source: {
          PATH: safePath,
          HOME: root,
          TMPDIR: root,
          LANG: 'C',
        },
        providerEnvironment: {
          CLAUDE_CODE_OAUTH_TOKEN: PROVIDER_SECRET,
        },
      });
      agentServer = createAgentServer({
        capacity: 2,
        serverUrl: controlUrl,
        provider: 'claude-code',
        deployment: 'local',
        stateDir,
        workDir,
        enrollmentToken: ENROLLMENT_SECRET,
        packageVersion: 'smoke',
        healthHost: '127.0.0.1',
        healthPort: 0,
        providerEnvironment: childEnvironment,
        acpCommand: process.execPath,
        acpArgs: [fixturePath, '--scenario', 'smoke', '--trace', acpTracePath, '--barrier', barrierDir],
        log: capturedLogger(logEntries),
        createRunner: (options) => createRunner({
          ...options,
          heartbeatIntervalMs: 75,
          commandPollMs: 20,
          eventFlushMs: 5,
          runtimeLimits: {
            requestTimeoutMs: 2_000,
            silenceMs: 2_000,
            shutdownIdleMs: 1_000,
            shutdownExitMs: 1_000,
            shutdownKillMs: 1_000,
            restartWindowMs: 60_000,
            maxRestarts: 3,
          },
        }),
        createHealthServer: (options) => {
          const health = createHealthServer(options);
          return {
            async start() {
              healthAddress = await health.start();
              return healthAddress;
            },
            async stop() {
              await health.stop();
              healthStopped = true;
            },
          };
        },
      });
      startPromise = agentServer.start();
      void startPromise.catch(() => undefined);
    },
    healthUrl() {
      ensure(healthAddress && typeof healthAddress === 'object', 'Health listener did not start');
      return `http://127.0.0.1:${healthAddress.port}`;
    },
    internalStatus() {
      return agentServer.getStatus();
    },
    async assertRuntimeContract() {},
    async assertStorage() {
      const statePath = join(stateDir, 'state.json');
      const [rootInfo, stateDirectoryInfo, workDirectoryInfo, stateInfo] = await Promise.all([
        stat(root),
        stat(stateDir),
        stat(workDir),
        stat(statePath),
      ]);
      assert.equal(rootInfo.mode & 0o777, 0o700);
      assert.equal(stateDirectoryInfo.mode & 0o777, 0o700);
      assert.equal(workDirectoryInfo.mode & 0o777, 0o700);
      assert.equal(stateInfo.mode & 0o777, 0o600);
    },
    readText: (path) => readFile(path, 'utf8'),
    async pathExists(path) {
      try {
        await stat(path);
        return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    },
    async stop() {
      await stopAgentServer();
      assert.equal(healthStopped, true);
    },
    logs: () => logEntries,
    diagnostics: () => '',
    dispose: stopAgentServer,
  };
}

async function createContainerLauncher(root) {
  const image = process.env.AGENT_SERVER_IMAGE;
  ensure(typeof image === 'string' && image.length > 0, 'AGENT_SERVER_IMAGE is required for the image smoke');
  const engine = process.env.CONTAINER_CLI || 'docker';
  const podman = basename(engine) === 'podman'
    || /podman/iu.test((await runEngine(engine, ['--version'])).stdout);
  const hostUid = process.getuid();
  const sharedPermissions = !podman && hostUid !== CONTAINER_UID;
  const dirMode = sharedPermissions ? 0o777 : 0o700;
  const fileMode = sharedPermissions ? 0o644 : 0o600;
  const userNamespace = podman ? ['--userns', `keep-id:uid=${CONTAINER_UID},gid=${CONTAINER_UID}`] : [];
  const suffix = randomBytes(4).toString('hex');
  const name = `fluent-flow-agent-server-smoke-${suffix}`;
  const volumes = [`${name}-work`, `${name}-state`];
  const hostState = join(root, 'state-mount');
  const hostWork = join(root, 'work-mount');
  const hostShared = join(root, 'shared-mount');
  const hostBarriers = join(hostShared, 'barriers');
  const hostBin = join(root, 'bin-mount');
  const hostSecrets = join(root, 'secrets');
  const hostProviderSecret = join(hostSecrets, 'provider-auth');
  const fixturePath = fileURLToPath(new URL('../tests/unit/fake-acp-agent.js', import.meta.url));
  const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const logicalStateDir = `${CONTAINER_PATHS.state}/agent-server`;
  const logicalWorkDir = `${CONTAINER_PATHS.work}/.fluent-flow/work`;
  const logicalBarrierDir = `${CONTAINER_PATHS.shared}/barriers`;
  let healthPort = null;
  let stopped = false;
  let finalLogs = '';
  let version = null;

  const exec = (args, options) => runEngine(engine, ['exec', name, ...args], options);
  const shareContainerFiles = () => runInImage('find', [
    CONTAINER_PATHS.state, CONTAINER_PATHS.work, CONTAINER_PATHS.shared,
    '-user', String(CONTAINER_UID), '-exec', 'chmod', 'a+rwX', '{}', '+',
  ], [
    '-v', `${hostState}:${CONTAINER_PATHS.state}`,
    '-v', `${hostWork}:${CONTAINER_PATHS.work}`,
    '-v', `${hostShared}:${CONTAINER_PATHS.shared}`,
  ]);
  const runInImage = (entrypoint, args, extra = [], options) => runEngine(engine, [
    'run', '--rm', '--network', 'none', '--user', CONTAINER_USER, ...userNamespace,
    ...extra, '--entrypoint', entrypoint, image, ...args,
  ], options);

  async function readLogs() {
    const { stdout, stderr } = await runEngine(engine, ['logs', name]);
    return `${stdout}${stderr}`;
  }

  async function assertImage() {
    const { stdout } = await runEngine(engine, ['image', 'inspect', '--format', '{{json .Config}}', image]);
    const config = JSON.parse(stdout);
    assert.equal(config.User, CONTAINER_USER, 'Image does not run as UID 1000');
    assert.equal(config.WorkingDir, '/work');
    assert.deepEqual(config.Entrypoint, ['node', '/app/packages/fluent-flow-agent-server/bin/fluent-flow-agent-server.js']);
    assert.ok(config.Env.includes('HOME=/home/node') && config.Env.includes('NODE_ENV=production'), 'Image environment was invalid');
    const healthcheck = JSON.parse((await runEngine(engine, ['image', 'inspect', '--format', '{{json .Config.Healthcheck}}', image])).stdout);
    assert.ok(healthcheck?.Test?.join(' ').includes('/healthz'), 'Image has no /healthz health check');
    for (const label of ['source', 'title', 'description', 'licenses']) {
      assert.ok(config.Labels?.[`org.opencontainers.image.${label}`], `Image label ${label} is missing`);
    }
    for (const variable of config.Env) {
      assert.equal(/TOKEN|SECRET|PASSWORD|AUTH/iu.test(variable.split('=')[0]), false, 'Image bakes a credential environment variable');
    }

    for (const [tool, ...args] of IMAGE_TOOLS) {
      const result = await runInImage(tool, args);
      assert.ok(result.stdout.trim().length > 0 || result.stderr.trim().length > 0, `${tool} printed nothing`);
    }
    const layout = await runInImage('sh', ['-c', [
      'test "$(id -u)" = 1000',
      '! command -v curl',
      '! command -v ssh',
      '! test -e /var/run/docker.sock',
      '! test -e /app/.git',
      '! test -e /app/packages/fluent-flow-agent-server/tests',
      'test -x /app/packages/fluent-flow-agent-server/bin/fluent-flow-agent-server.js',
      'echo layout-ok',
    ].join(' && ')]);
    assert.equal(layout.stdout.trim(), 'layout-ok');

    await Promise.all(volumes.map((volume) => runEngine(engine, ['volume', 'create', volume])));
    const writable = await runInImage('sh', ['-c', 'touch /work/.probe && touch /home/node/.fluent-flow/.probe && echo volumes-ok'], [
      '-v', `${volumes[0]}:${CONTAINER_PATHS.work}`,
      '-v', `${volumes[1]}:${CONTAINER_PATHS.state}`,
    ]);
    assert.equal(writable.stdout.trim(), 'volumes-ok');
  }

  return {
    expected: null,
    stateDir: logicalStateDir,
    workDir: logicalWorkDir,
    barrierDir: hostBarriers,
    gitTracePath: `${CONTAINER_PATHS.shared}/git-trace.jsonl`,
    acpTracePath: `${CONTAINER_PATHS.shared}/acp-trace.jsonl`,
    fileMode,
    async prepare() {
      version = JSON.parse(await readFile(manifestPath, 'utf8')).version;
      this.expected = { deployment: 'self_hosted', version };
      await Promise.all([hostState, hostWork, hostShared, hostBin, hostSecrets].map((directory) => (
        mkdir(directory, { recursive: true, mode: dirMode })
      )));
      await mkdir(hostBarriers, { recursive: true, mode: dirMode });
      await Promise.all([hostState, hostWork, hostShared, hostBin, hostSecrets, hostBarriers].map((directory) => chmod(directory, dirMode)));
      await createFakeGit(hostBin, this.gitTracePath, sharedPermissions ? 0o755 : 0o700);
      await writeFile(hostProviderSecret, `${PROVIDER_SECRET}\n`, { mode: fileMode });
      await chmod(hostProviderSecret, fileMode);
      healthPort = await discoverFreePort();
      await assertImage();
    },
    async start(controlUrl) {
      const args = [
        'run', '-d', '--name', name,
        '--init',
        '--network', 'host',
        '--user', CONTAINER_USER,
        ...userNamespace,
        '--read-only',
        '--tmpfs', '/tmp',
        '--tmpfs', '/home/node:mode=1777',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '-e', `PATH=${CONTAINER_PATHS.bin}:${CONTAINER_BASE_PATH}`,
        '-e', `FLUENT_FLOW_HEARTBEAT_MS=${CONTAINER_HEARTBEAT_MS}`,
        '-v', `${hostState}:${CONTAINER_PATHS.state}`,
        '-v', `${hostWork}:${CONTAINER_PATHS.work}`,
        '-v', `${hostShared}:${CONTAINER_PATHS.shared}`,
        '-v', `${hostBin}:${CONTAINER_PATHS.bin}:ro`,
        '-v', `${fixturePath}:${CONTAINER_PATHS.fixture}:ro`,
        '-v', `${hostProviderSecret}:${CONTAINER_PATHS.providerSecret}:ro`,
        image,
        '--server', controlUrl,
        '--provider', 'claude-code',
        '--capacity', '2',
        '--deployment', 'self_hosted',
        '--enrollment-token', ENROLLMENT_SECRET,
        '--provider-secret-file', CONTAINER_PATHS.providerSecret,
        '--health-host', '127.0.0.1',
        '--health-port', String(healthPort),
        '--acp-command', 'node',
        '--acp-arg', CONTAINER_PATHS.fixture,
        '--acp-arg', '--scenario',
        '--acp-arg', 'smoke',
        '--acp-arg', '--trace',
        '--acp-arg', this.acpTracePath,
        '--acp-arg', '--barrier',
        '--acp-arg', logicalBarrierDir,
      ];
      await runEngine(engine, args);
      livenessCheck = async () => {
        const { stdout } = await runEngine(engine, ['inspect', '--format', '{{.State.Running}}', name]);
        if (stdout.trim() !== 'true') {
          throw new Error(`Container stopped unexpectedly:\n${redact(await readLogs())}`);
        }
      };
    },
    healthUrl: () => `http://127.0.0.1:${healthPort}`,
    internalStatus: () => null,
    async assertRuntimeContract() {
      assert.equal((await exec(['id', '-u'])).stdout.trim(), String(CONTAINER_UID));
      assert.equal((await exec(['id', '-g'])).stdout.trim(), String(CONTAINER_UID));
      const mounts = (await exec(['cat', '/proc/self/mounts'])).stdout.split('\n').map((line) => line.split(' '));
      const rootMount = mounts.find((columns) => columns[1] === '/');
      assert.ok(rootMount?.[3].split(',').includes('ro'), 'Container root filesystem was writable');
      const writableHome = await exec(['sh', '-c', 'touch "$HOME/.claude.json" /tmp/.smoke-probe && echo home-ok']);
      assert.equal(writableHome.stdout.trim(), 'home-ok');
      const listeners = JSON.parse((await exec(['node', '-e', LISTENER_SCAN])).stdout);
      assert.deepEqual(listeners, [healthPort], 'Container claimed a port other than the health port');
    },
    async assertStorage() {
      const modeOf = async (path) => (await exec(['stat', '-c', '%a', path])).stdout.trim();
      assert.equal(await modeOf(logicalStateDir), '700');
      assert.equal(await modeOf(`${logicalStateDir}/state.json`), '600');
    },
    async readText(path) {
      return (await exec(['cat', path])).stdout;
    },
    async pathExists(path) {
      return (await exec(['test', '-e', path], { allowFailure: true })).code === 0;
    },
    async stop() {
      if (stopped) return;
      await runEngine(engine, ['kill', '--signal', 'SIGTERM', name]);
      const { stdout } = await runEngine(engine, ['wait', name], { timeoutMs: SHUTDOWN_DEADLINE_MS });
      assert.equal(stdout.trim(), '0', 'Container did not exit cleanly after SIGTERM');
      finalLogs = await readLogs();
      stopped = true;
      livenessCheck = null;
    },
    logs: () => finalLogs,
    diagnostics: () => redact(finalLogs),
    async dispose() {
      livenessCheck = null;
      const errors = [];
      const exists = (await runEngine(engine, ['container', 'inspect', name], { allowFailure: true })).code === 0;
      if (exists) {
        if (!stopped) {
          try {
            finalLogs = await readLogs();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await runEngine(engine, ['rm', '-f', name]);
        } catch (error) {
          errors.push(error);
        }
      }
      if (sharedPermissions && (await Promise.all([hostState, hostWork, hostShared].map(hostPathExists))).every(Boolean)) {
        try {
          await shareContainerFiles();
        } catch (error) {
          errors.push(error);
        }
      }
      const volumeResults = await Promise.allSettled(volumes.map((volume) => runEngine(engine, ['volume', 'rm', '-f', volume])));
      for (const result of volumeResults) if (result.status === 'rejected') errors.push(result.reason);
      if (errors.length > 0) throw new AggregateError(errors, 'Container cleanup failed');
    },
  };
}

async function main() {
  let root = null;
  let launcher = null;
  let control = null;
  let controlStopped = false;
  let failure = null;
  const healthBodies = [];

  async function stopControlPlane() {
    if (!control || controlStopped) return;
    await control.close();
    controlStopped = true;
  }

  try {
    root = await mkdtemp(join(tmpdir(), 'fluent-flow-agent-server-smoke-'));
    await chmod(root, 0o700);
    launcher = IMAGE_MODE ? await createContainerLauncher(root) : await createProcessLauncher(root);
    await launcher.prepare();
    control = await createControlPlane(launcher.expected);
    await launcher.start(control.url);

    await waitFor('two registered sessions', () => control.registrations.size === 2);
    assert.equal(control.sessionOrder.length, 2);
    assert.equal(new Set(control.sessionOrder).size, 2);
    assert.deepEqual(
      [...control.registrations.values()].map((meta) => meta.slot_id).sort((left, right) => left - right),
      [0, 1],
    );
    assert.equal(new Set([...control.registrations.values()].map((meta) => meta.instance_id)).size, 1);
    const healthUrl = launcher.healthUrl();

    const onlineStatus = await waitFor('two online health slots', async () => {
      const status = await getStatus(healthUrl);
      healthBodies.push(status);
      return status.status === 'healthy' && status.online_slots === 2 ? status : null;
    });
    assert.equal(onlineStatus.capacity, 2);
    const internalOnline = launcher.internalStatus();
    if (internalOnline) assert.equal(internalOnline.online_slots, 2);
    const healthStatus = await getStatus(healthUrl, '/healthz');
    healthBodies.push(healthStatus);
    assert.equal(healthStatus.status, 'healthy');
    assert.equal(healthStatus.online_slots, 2);

    await waitFor('overlapping ACP running states', () => (
      control.runningClaims.has(1) && control.runningClaims.has(2)
    ));
    const overlappingStatus = await waitFor('two active health slots', async () => {
      const status = await getStatus(healthUrl);
      healthBodies.push(status);
      return status.active === 2 ? status : null;
    });
    assert.equal(overlappingStatus.status, 'healthy');
    const internalActive = launcher.internalStatus();
    if (internalActive) assert.equal(internalActive.active, 2);
    await launcher.assertRuntimeContract();
    await writeFile(join(launcher.barrierDir, 'claim-2'), 'ready\n', { mode: launcher.fileMode });
    control.allowRelease();

    await waitFor('claim 1 ownership release', () => control.claim1ReleaseSequence !== null);
    await waitFor('claim 3 delivery', () => control.claim3DeliverySequence !== null);
    ensure(
      control.claim3DeliverySequence > control.claim1ReleaseSequence,
      'Claim 3 was delivered before claim 1 ownership released',
    );
    await waitFor('claim 3 ACP running state', () => control.runningClaims.has(3));
    await writeFile(join(launcher.barrierDir, 'claim-3'), 'ready\n', { mode: launcher.fileMode });
    await waitFor('claims 2 and 3 completion reports', () => (
      control.reports.length === 2 && control.activeClaims.size === 0
    ));
    await waitFor('zero active health slots', async () => {
      const status = await getStatus(healthUrl);
      healthBodies.push(status);
      return status.active === 0;
    });

    assert.equal(control.errors.length, 0);
    assert.equal(control.maxActiveClaims, 2);
    assert.equal(control.reports.length, 2);
    assert.deepEqual(control.reports.map((report) => report.claim_id).sort((left, right) => left - right), [2, 3]);
    for (const report of control.reports) {
      assert.equal(report.status, 'completed');
      assert.equal(report.repo, REPOSITORY);
      assert.equal(report.pr_number, 100 + report.claim_id);
      assert.equal(report.attempt, 1);
      assert.equal(report.session_id, control.sessionForClaim(report.claim_id));
    }
    assert.equal(control.reports.some((report) => report.claim_id === 1), false);
    assert.equal(control.sessionForClaim(3), control.sessionForClaim(1));
    assert.notEqual(control.sessionForClaim(1), control.sessionForClaim(2));
    assert.deepEqual([...control.commandPolls.keys()].sort((left, right) => left - right), [1, 2, 3]);
    assert.deepEqual([...control.runningClaims].sort((left, right) => left - right), [1, 2, 3]);

    const eventAcpSessions = [1, 2, 3].map((claimId) => {
      const sessions = control.acpSessionsByClaim.get(claimId);
      ensure(sessions?.size === 1, `Claim ${claimId} did not use exactly one ACP session`);
      return [...sessions][0];
    });
    assert.equal(new Set(eventAcpSessions).size, 3);

    const gitTrace = parseJsonLines(await launcher.readText(launcher.gitTracePath));
    const additions = gitTrace.filter((entry) => entry.operation === 'worktree-add');
    const removals = gitTrace.filter((entry) => entry.operation === 'worktree-remove');
    assert.deepEqual(
      additions.map((entry) => entry.worktree.match(/claim-\d+$/u)?.[0]).sort(),
      ['claim-1', 'claim-2', 'claim-3'],
    );
    assert.deepEqual(
      removals.map((entry) => entry.worktree.match(/claim-\d+$/u)?.[0]).sort(),
      ['claim-1', 'claim-2', 'claim-3'],
    );
    for (const addition of additions) {
      assert.equal(await launcher.pathExists(addition.worktree), false, 'Worktree was not removed');
    }

    const remotePath = join(launcher.workDir, '.fluent-flow', 'repos', 'fluent-io', 'smoke-repo', '.git', 'fake-origin');
    const storedRemote = (await launcher.readText(remotePath)).trim();
    ensure(storedRemote === 'https://github.com/fluent-io/smoke-repo.git', 'Stored Git remote was not the clean HTTPS URL');
    const stateContents = JSON.parse(await launcher.readText(join(launcher.stateDir, 'state.json')));
    await launcher.assertStorage();
    assert.equal(stateContents.instanceId, control.enrollmentInstanceId);
    ensure(stateContents.token === DURABLE_SECRET, 'Private state durable credential did not match enrollment exchange');

    const acpTrace = parseJsonLines(await launcher.readText(launcher.acpTracePath));
    assert.equal(acpTrace.filter((entry) => entry.kind === 'process_start').length, 3);
    assert.equal(acpTrace.filter((entry) => entry.kind === 'session_close').length, 3);
    assert.equal(
      acpTrace.some((entry) => entry.kind === 'session_cancel' && entry.params?.sessionId === eventAcpSessions[0]),
      true,
      'Claim 1 ACP session was not cancelled',
    );

    await launcher.stop();
    await assert.rejects(fetch(`${healthUrl}/status`, { signal: AbortSignal.timeout(1_000) }));
    assertNoSecrets('captured logs', launcher.logs());
    assertNoSecrets('Git trace', gitTrace);
    assertNoSecrets('stored remote', storedRemote);
    assertNoSecrets('claim reports', control.reports);
    assertNoSecrets('health responses', healthBodies);
    assertNoSecrets('claim events', control.events);
    assertNoSecrets('ACP trace', acpTrace);
    for (const status of healthBodies) {
      for (const sessionId of control.sessionOrder) {
        assert.equal(JSON.stringify(status).includes(sessionId), false, 'Health response exposed a session ID');
      }
    }

    await stopControlPlane();
    assert.equal(control.server.listening, false);
    assert.equal(control.errors.length, 0);
  } catch (error) {
    failure = error;
  } finally {
    const cleanupResults = await Promise.allSettled([
      launcher ? launcher.dispose() : Promise.resolve(),
      stopControlPlane(),
    ]);
    const cleanupErrors = cleanupResults.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (root) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (failure && launcher) {
      const diagnostics = launcher.diagnostics();
      if (diagnostics) process.stderr.write(`${diagnostics}\n`);
    }
    if (failure && cleanupErrors.length > 0) {
      throw new AggregateError([failure, ...cleanupErrors], 'Smoke scenario and cleanup failed');
    }
    if (failure) throw failure;
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Smoke cleanup failed');
  }

  process.stdout.write(IMAGE_MODE ? 'Portable agent server image smoke passed.\n' : 'Portable agent server smoke passed.\n');
}

await main();
