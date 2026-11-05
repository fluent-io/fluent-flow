import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createIpcServer } from '../../../src/supervisor/ipc.js';
import { runSupervisorCommand, SHUTDOWN_UNCERTAIN } from '../../../src/supervisor/cli.js';
import { cleanupRoots, RUN, S1, setup, launch, memoryContainment } from './helpers/dispatch-fakes.js';

const servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  cleanupRoots();
});

function capture() {
  let text = '';
  return { output: { write: (chunk) => { text += chunk; return true; } }, get text() { return text; } };
}

async function serve(t, instanceId) {
  const server = createIpcServer({ instanceId, stateDir: t.stateDir, handlers: t.handlers, log: () => {} });
  servers.push(server);
  await server.listen();
  return server;
}

describe('runSupervisorCommand', () => {
  it('status prints no payloads', async () => {
    const t = setup();
    await t.handlers.submit(launch({ reporting: { url: 'http://127.0.0.1:9/mcp/collab', credential: 'reporting-credential-XYZ' } }));
    await t.handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'TOP-SECRET-PROMPT' });
    t.backend.workers[0].emit({ kind: 'timeline', nativeEventId: 'n1', payload: { type: 'assistant_text', text: 'SECRET-ASSISTANT-OUTPUT' } });
    await serve(t, 'inst-a');
    for (const command of ['status', 'list']) {
      const io = capture();
      expect(await runSupervisorCommand({ command, stateDir: t.stateDir, instanceId: 'inst-a', options: {}, io })).toBe(0);
      expect(io.text).toContain(S1);
      expect(io.text).toContain(RUN);
      expect(io.text).toContain('claude-code');
      expect(io.text).not.toMatch(/TOP-SECRET-PROMPT|SECRET-ASSISTANT-OUTPUT|reporting-credential|native-|\/mem\/ff-/);
      if (command === 'status') {
        expect(io.text).toContain('Instance: inst-a');
        expect(io.text).toContain('Containment: verified');
        expect(io.text).toMatch(/Capacity: claude-code 1\/4/);
        expect(io.text).toMatch(/active/);
      }
    }
  });

  it('status reports a not running supervisor without starting one', async () => {
    const t = setup();
    const io = capture();
    expect(await runSupervisorCommand({ command: 'status', stateDir: t.stateDir, instanceId: 'inst-a', options: {}, io })).toBe(0);
    expect(io.text).toContain('Supervisor: not running');
  });

  it('stop is limited to the instance', async () => {
    const a = setup();
    const b = setup();
    await a.handlers.submit(launch());
    await b.handlers.submit(launch());
    await serve(a, 'inst-a');
    await serve(b, 'inst-b');
    const io = capture();
    expect(await runSupervisorCommand({ command: 'stop', stateDir: a.stateDir, instanceId: 'inst-a', options: {}, io })).toBe(0);
    expect(io.text).toContain('Runner stopped.');
    expect(a.mem.kills).toHaveLength(1);
    expect(b.mem.kills).toEqual([]);
    expect(b.backend.workers[0].interrupts).toEqual([]);
    expect((await b.handlers.status()).admissionStopped).toBe(false);
  });

  it('an unconfirmed stop prints the shutdown message and exits 1', async () => {
    const t = setup({ mem: memoryContainment({ stuck: true }) });
    await t.handlers.submit(launch());
    await serve(t, 'inst-a');
    const io = capture();
    expect(await runSupervisorCommand({ command: 'stop', stateDir: t.stateDir, instanceId: 'inst-a', options: { timeoutMs: 300 }, io })).toBe(1);
    expect(io.text).toContain(SHUTDOWN_UNCERTAIN);
    expect(SHUTDOWN_UNCERTAIN).toBe("Shutdown could not be confirmed. Check the runner's status before continuing.");
  });

  it('an unknown command is refused with usage', async () => {
    const t = setup();
    mkdirSync(join(t.stateDir, 'x'), { recursive: true });
    const io = capture();
    expect(await runSupervisorCommand({ command: 'restart', stateDir: t.stateDir, instanceId: 'inst-a', options: {}, io })).toBe(1);
  });
});
