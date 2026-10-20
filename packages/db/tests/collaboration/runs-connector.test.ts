import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  resolveCollabTestDatabaseUrl,
  resetCollabSchema,
  seedLegacyUser,
  seedLegacyOrgMembership,
} from '../helpers/collab-db.js';
import { runMigrations } from '../../src/migrate.js';
import { closePool, getPool } from '../../src/pool.js';
import { getCollabProjectInsights } from '../../src/collaboration/evidence.js';
import {
  ensureGithubPrincipal,
  bootstrapCollaborationWorkspace,
  createCollabProject,
  createCollabTask,
  createExecutionHost,
  revokeExecutionHost,
  createProjectHostMapping,
  startCollabRun,
  pollConnectorCommands,
  ackConnectorCommand,
  submitConnectorObservations,
  registerConnector,
  heartbeatConnector,
  removeCollabMember,
  submitSessionCommand,
  createCollabComment,
  listCollabComments,
  listTaskEvents,
  markTaskRead,
  listAttention,
  getCollabRun,
  listCollabRuns,
  createRunSession,
  getConnectorCommand,
  getSessionTimeline,
} from '../../src/collaboration/identity.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const DATABASE_URL = process.env.DATABASE_URL;

describe('A3 durable queue and host protocol (real Postgres)', () => {
  let managerActor;
  let operatorActor;
  let projectId;
  let taskId;
  let hostToken;
  let hostId;
  let mappingId;
  let connector;

  async function rawQuery(text, params) {
    const client = new (await import('pg')).Client({ connectionString: DATABASE_URL });
    try {
      await client.connect();
      const result = await client.query(text, params);
      return result.rows;
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    // Server key for reporting-credential derivation (test-only value).
    process.env.FF_COLLAB_AUTH_SECRET = 'collab-test-secret-0123456789abcdef0123456789abcdef';
    await resetCollabSchema(DATABASE_URL);
    await runMigrations();

    const legacyAdmin = await seedLegacyUser(DATABASE_URL, { githubId: 9501, login: 'exec-owner' });
    await seedLegacyOrgMembership(DATABASE_URL, legacyAdmin, 'exec-org', 'admin');
    const principal = await ensureGithubPrincipal({
      legacyUserId: legacyAdmin,
      displayName: 'Exec Owner',
      email: 'exec-owner@example.test',
    });
    managerActor = { principalId: principal.id, sessionVersion: principal.sessionVersion };

    const ws = await bootstrapCollaborationWorkspace({
      actor: managerActor,
      legacyOrgId: 'exec-org',
      name: 'Exec Client',
      idempotencyKey: 'exec-ws-01',
    });
    const project = await createCollabProject({ actor: managerActor, workspaceId: ws.id, name: 'Exec P1' });
    projectId = project.id;

    // Operator role membership for run.start capability coverage.
    const operatorRole = await rawQuery(
      `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'operator'`,
      [ws.id],
    );
    const operator = await rawQuery(
      `INSERT INTO collab_principals (display_name, email) VALUES ('Exec Operator', 'exec-operator@example.test') RETURNING id, session_version`,
    );
    await rawQuery(
      `INSERT INTO collab_memberships (workspace_id, principal_id, role_id) VALUES ($1, $2, $3)`,
      [ws.id, operator[0].id, operatorRole[0].id],
    );
    operatorActor = { principalId: operator[0].id, sessionVersion: operator[0].session_version };

    taskId = (await createCollabTask({ actor: managerActor, projectId, title: 'Exec task' })).id;

    const host = await createExecutionHost({ actor: managerActor, name: 'PC Studio' });
    hostToken = host.token;
    hostId = host.id;
    const mapping = await createProjectHostMapping({
      actor: managerActor,
      projectId,
      hostId,
      repositoryKey: 'fluent-io/fluent-flow',
      profileIds: ['ai3-coder'],
      defaultProfileId: 'ai3-coder',
    });
    mappingId = mapping.id;

    connector = await registerConnector({
      token: hostToken,
      instanceId: 'inst-1',
      protocolVersion: 1,
      sdkVersion: '0.12.0',
      daemonVersion: '1.0.0',
      capabilities: {},
      catalog: { repositories: [{ key: 'fluent-io/fluent-flow' }], profiles: [{ id: 'ai3-coder', name: 'AI3 Coder', provider: 'omp', model: 'glm' }] },
    });
  });

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    await closePool();
  });

  it('creates a run idempotently; same key returns the same run, different payload conflicts', async () => {
    const body = { mappingId, profileId: 'ai3-coder', instructions: 'Do the thing' };
    const first = await startCollabRun({
      actor: operatorActor,
      taskId,
      expectedVersion: global.__execTaskVersion ?? 1,
      idempotencyKey: 'idem-run-1',
      ...body,
    });
    expect(first.run.state).toBe('queued');
    expect(first.created).toBe(true);

    const replay = await startCollabRun({
      actor: operatorActor,
      taskId,
      expectedVersion: global.__execTaskVersion ?? 1,
      idempotencyKey: 'idem-run-1',
      ...body,
    });
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe(first.run.id);

    await expect(
      startCollabRun({ actor: operatorActor, taskId, expectedVersion: 1, idempotencyKey: 'idem-run-1', mappingId, profileId: 'other-model', instructions: 'Different' }),
    ).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
  });

  it('keeps exactly one active run per task', async () => {
    await expect(
      startCollabRun({ actor: operatorActor, taskId, expectedVersion: 1, idempotencyKey: 'idem-run-2', mappingId, profileId: 'ai3-coder', instructions: 'Second' }),
    ).rejects.toMatchObject({ status: 409, code: 'active_run_exists' });
  });

  it('poll delivers only the launch command for this host with fencing data', async () => {
    const polled = await pollConnectorCommands({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      waitMs: 0,
      limit: 1,
    });
    expect(polled.commands).toHaveLength(1);
    expect(polled.commands[0].kind).toBe('launch');
    expect(polled.commands[0].payload.repositoryKey).toBe('fluent-io/fluent-flow');
    expect(JSON.stringify(polled.commands[0].payload)).not.toMatch(/token|secret/i);
    global.__launchCommandId = polled.commands[0].id;
  });

  it('rejects stale-fence acks and accepts the current one idempotently', async () => {
    await expect(
      ackConnectorCommand({
        token: hostToken,
        connectorSessionId: connector.connectorSessionId,
        leaseEpoch: connector.leaseEpoch - 1,
        commandId: global.__launchCommandId,
        state: 'applied',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'stale_lease' });

    await ackConnectorCommand({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      commandId: global.__launchCommandId,
      state: 'accepted',
    });
    // Replay of the terminal ack is idempotent.
    await ackConnectorCommand({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      commandId: global.__launchCommandId,
      state: 'accepted',
    });
  });

  it('binds workspace/session via observations and projects host truth on the run', async () => {
    const accepted = await submitConnectorObservations({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      events: [
        {
          eventId: 'evt-1',
          runId: global.__launchRunId ?? (await listCollabRuns({ actor: managerActor, taskId })).runs[0].id,
          sessionId: null,
          observedAt: new Date().toISOString(),
          kind: 'workspace_bound',
          payload: { workspaceId: 'paseo-ws-1' },
        },
        {
          eventId: 'evt-2',
          runId: (await listCollabRuns({ actor: managerActor, taskId })).runs[0].id,
          sessionId: null,
          observedAt: new Date().toISOString(),
          kind: 'state',
          payload: { state: 'running' },
          providerCursor: { epoch: 'e1', seq: '1' },
        },
      ],
    });
    expect(accepted.acceptedEventIds).toHaveLength(2);

    // Replay with identical binding consumes the sender's pending entry
    // (accepted) WITHOUT duplicating the row or re-projecting.
    const replay = await submitConnectorObservations({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      events: [
        {
          eventId: 'evt-1',
          runId: (await listCollabRuns({ actor: managerActor, taskId })).runs[0].id,
          sessionId: null,
          observedAt: new Date().toISOString(),
          kind: 'workspace_bound',
          payload: { workspaceId: 'paseo-ws-1' },
        },
      ],
    });
    expect(replay.acceptedEventIds).toEqual(['evt-1']);

    const runId = (await listCollabRuns({ actor: managerActor, taskId })).runs[0].id;
    global.__launchRunId = runId;
    const detail = await getCollabRun(managerActor, runId);
    expect(detail.run.state).toBe('running');
    expect(detail.run.hostName).toBe('PC Studio');
    expect(['online', 'stale', 'offline']).toContain(detail.run.hostReachability);
  });

  it('survives a pool restart between claim and ack without losing the command', async () => {
    const runId = global.__launchRunId;
    const session = await rawQuery(
      `INSERT INTO collab_sessions (run_id, title) VALUES ($1, 'Work session') RETURNING id`,
      [runId],
    );
    await rawQuery(
      `INSERT INTO collab_connector_commands (host_id, run_id, session_id, kind, payload)
       VALUES ($1, $2, $3, 'prompt', $4)`,
      [hostId, runId, session[0].id, JSON.stringify({ kind: 'prompt', text: 'go', behavior: 'steer' })],
    );

    let polled = await pollConnectorCommands({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      waitMs: 0,
      limit: 1,
    });
    // The accepted launch may resume after its settle window; reconcile it by
    // id (apply) exactly as a real connector would, then continue to the prompt.
    while (polled.commands.length > 0 && polled.commands[0].kind !== 'prompt') {
      await ackConnectorCommand({
        token: hostToken,
        connectorSessionId: connector.connectorSessionId,
        leaseEpoch: connector.leaseEpoch,
        commandId: polled.commands[0].id,
        state: 'applied',
        result: { reconciled: true },
      });
      polled = await pollConnectorCommands({
        token: hostToken,
        connectorSessionId: connector.connectorSessionId,
        leaseEpoch: connector.leaseEpoch,
        waitMs: 0,
        limit: 1,
      });
    }
    expect(polled.commands[0].kind).toBe('prompt');

    // Process restart: close and reopen the pool.
    await closePool();
    const stillPending = await rawQuery(
      `SELECT state FROM collab_connector_commands WHERE id = $1`,
      [polled.commands[0].id],
    );
    expect(stillPending[0].state).toBe('claimed');

    await ackConnectorCommand({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      commandId: polled.commands[0].id,
      state: 'applied',
      result: { delivered: true },
    });
    const done = await rawQuery(`SELECT state FROM collab_connector_commands WHERE id = $1`, [
      polled.commands[0].id,
    ]);
    expect(done[0].state).toBe('applied');
  });

  it('rejects revoked hosts and wrong-host access', async () => {
    const secondHost = await createExecutionHost({ actor: managerActor, name: 'Other Box' });
    // Valid token + ANOTHER host's session: fence mismatch, not auth failure.
    await expect(
      pollConnectorCommands({
        token: secondHost.token,
        connectorSessionId: connector.connectorSessionId,
        leaseEpoch: connector.leaseEpoch,
        waitMs: 0,
        limit: 1,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'stale_lease' });

    await revokeExecutionHost({ actor: managerActor, hostId: secondHost.id });
    // Revoked token: register AND poll are unauthenticated (indistinguishable
    // from unknown token).
    await expect(
      registerConnector({
        token: secondHost.token,
        instanceId: 'inst-2',
        protocolVersion: 1,
        sdkVersion: '0.12.0',
        daemonVersion: '1.0.0',
        capabilities: {},
        catalog: { repositories: [], profiles: [] },
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      pollConnectorCommands({
        token: secondHost.token,
        connectorSessionId: connector.connectorSessionId,
        leaseEpoch: connector.leaseEpoch,
        waitMs: 0,
        limit: 1,
      }),
    ).rejects.toMatchObject({ status: 401 });

    // Unknown token is 401 indistinguishable from revoked.
    await expect(
      pollConnectorCommands({
        token: 'ff-host-unknown-token-value',
        connectorSessionId: connector.connectorSessionId,
        leaseEpoch: connector.leaseEpoch,
        waitMs: 0,
        limit: 1,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('refuses host administration to non-internal admins', async () => {
    await expect(
      createExecutionHost({ actor: operatorActor, name: 'Sneaky Host' }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('accepts state+usage fanout on one cursor without dropping either', async () => {
    const runId = (await listCollabRuns({ actor: managerActor, taskId })).runs[0].id;
    const sessionId = (
      await rawQuery(`SELECT id FROM collab_sessions WHERE run_id = $1 ORDER BY created_at LIMIT 1`, [runId])
    )[0].id;

    const batch = await submitConnectorObservations({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      events: [
        {
          eventId: 'fanout-state',
          runId,
          sessionId,
          observedAt: new Date().toISOString(),
          kind: 'state',
          payload: { state: 'idle' },
          providerCursor: { epoch: 'e9', seq: '42' },
        },
        {
          eventId: 'fanout-usage',
          runId,
          sessionId,
          observedAt: new Date().toISOString(),
          kind: 'usage',
          payload: { sampleKey:'fanout-turn', tokensIn: 10, tokensOut: 5 },
          providerCursor: { epoch: 'e9', seq: '42' },
        },
      ],
    });
    expect(batch.acceptedEventIds).toEqual(['fanout-state', 'fanout-usage']);

    const kinds = await rawQuery(
      `SELECT kind FROM collab_connector_observations WHERE run_id = $1 AND provider_epoch = 'e9' ORDER BY kind`,
      [runId],
    );
    expect(kinds.map((k) => k.kind).sort()).toEqual(['state', 'usage']);

    // Replay of the same eventIds stays deduped.
    const replay = await submitConnectorObservations({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      events: [
        {
          eventId: 'fanout-state',
          runId,
          sessionId,
          observedAt: new Date().toISOString(),
          kind: 'state',
          payload: { state: 'idle' },
          providerCursor: { epoch: 'e9', seq: '42' },
        },
      ],
    });
    expect(replay.acceptedEventIds).toEqual(['fanout-state']);
  });

  it('tracks high-watermarks per session, not per run', async () => {
    const runId = (await listCollabRuns({ actor: managerActor, taskId })).runs[0].id;
    const sessionA = (
      await rawQuery(`SELECT id FROM collab_sessions WHERE run_id = $1 ORDER BY created_at LIMIT 1`, [runId])
    )[0].id;
    const sessionB = (
      await rawQuery(
        `INSERT INTO collab_sessions (run_id, title) VALUES ($1, 'Second session') RETURNING id`,
        [runId],
      )
    )[0].id;

    const base = { token: hostToken, connectorSessionId: connector.connectorSessionId, leaseEpoch: connector.leaseEpoch };
    const first = await submitConnectorObservations({
      ...base,
      events: [
        { eventId: 'wm-a1', runId, sessionId: sessionA, observedAt: new Date().toISOString(), kind: 'timeline', payload: { seq: 1 }, providerCursor: { epoch: 'ee', seq: '10' } },
      ],
    });
    expect(first.highWatermarks[`${runId}:${sessionA}:ee`]).toBe('10');

    // Session B may legitimately be BEHIND session A on the same epoch.
    const second = await submitConnectorObservations({
      ...base,
      events: [
        { eventId: 'wm-b1', runId, sessionId: sessionB, observedAt: new Date().toISOString(), kind: 'timeline', payload: { seq: 1 }, providerCursor: { epoch: 'ee', seq: '3' } },
      ],
    });
    expect(second.highWatermarks[`${runId}:${sessionB}:ee`]).toBe('3');
    expect(second.highWatermarks[`${runId}:${sessionA}:ee`]).toBeUndefined();
  });
  it('mints a stable bound credential at run start; raw token never stored', async () => {
    const credTask = await createCollabTask({ actor: managerActor, projectId, title: 'Credential task' });
    const run = await startCollabRun({
      actor: operatorActor,
      taskId: credTask.id,
      expectedVersion: 1,
      idempotencyKey: 'idem-cred-1',
      mappingId,
      profileId: 'ai3-coder',
      instructions: 'credential flow',
    });
    // Drain the launch command: delivery carries the reporting credential.
    const polled = await pollConnectorCommands({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      waitMs: 0,
      limit: 5,
    });
    const launch = polled.commands.find((c) => c.kind === 'launch' && c.runId === run.run.id);
    expect(launch).toBeDefined();
    expect(launch.payload.reportingCredential).toMatch(/^ffag_/);

    // Stability is structural: the credential is one row per session, and
    // every (re)delivery attaches that row's prefix — never a fresh mint.
    const mintCount = await rawQuery(
      `SELECT count(*)::int AS n FROM collab_scoped_tokens WHERE session_id = $1`,
      [run.sessionId],
    );
    expect(mintCount[0].n).toBe(1);

    // Idempotent run replay must not mint a second credential either.
    await startCollabRun({
      actor: operatorActor,
      taskId: credTask.id,
      expectedVersion: 1,
      idempotencyKey: 'idem-cred-1',
      mappingId,
      profileId: 'ai3-coder',
      instructions: 'credential flow',
    });
    const mintCountAfterReplay = await rawQuery(
      `SELECT count(*)::int AS n FROM collab_scoped_tokens WHERE session_id = $1`,
      [run.sessionId],
    );
    expect(mintCountAfterReplay[0].n).toBe(1);

    // At rest: hash + prefix only — the raw token is nowhere in the DB.
    const stored = await rawQuery(
      `SELECT token_hash, token_prefix, scopes, project_id, run_id, session_id
       FROM collab_scoped_tokens WHERE session_id = $1`,
      [run.sessionId],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].token_prefix).toBe(launch.payload.reportingCredential.slice(0, 12));
    // At rest: hash + bounded prefix only — there is no column or value that
    // could reconstruct the raw credential (9-char prefix, 64-char hash).
    expect(stored[0].token_prefix.length).toBeLessThanOrEqual(12);
    expect(stored[0].token_hash).toHaveLength(64);
    expect(stored[0].token_hash).not.toBe(stored[0].token_prefix);
    expect(stored[0].scopes).toContain('report.check');
    expect(stored[0].scopes).not.toContain('run.start');
    expect(stored[0].run_id).toBe(run.run.id);

    // FUNCTIONAL: the EXACT credential delivered by poll authenticates and
    // resolves the narrowed bound context.
    const { authenticateAgentToken } = await import('../../src/collaboration/identity.js');
    const context = await authenticateAgentToken(launch.payload.reportingCredential);
    expect(context.kind).toBe('agent');
    expect(context.runId).toBe(stored[0].run_id);
    expect(context.sessionId).toBe(run.sessionId);
    expect(context.capabilities).toContain('report.check');
    expect(context.capabilities).not.toContain('run.start');
    await expect(authenticateAgentToken('ffag_totally-unknown-token')).rejects.toMatchObject({ status: 401 });
  });

  it('never delivers queued work after authorization withdrawal while offline', async () => {
    // Operator starts a run, then loses membership BEFORE the PC polls.
    const withdrawnTask = await createCollabTask({ actor: managerActor, projectId, title: 'Withdrawn task' });
    const withdrawnRun = await startCollabRun({
      actor: operatorActor,
      taskId: withdrawnTask.id,
      expectedVersion: 1,
      idempotencyKey: 'idem-withdraw-1',
      mappingId,
      profileId: 'ai3-coder',
      instructions: 'must not execute',
    });
    const execWorkspaceId = (
      await rawQuery(`SELECT workspace_id FROM collab_projects WHERE id = $1`, [projectId])
    )[0].workspace_id;
    try {
      await removeCollabMember({
        actor: managerActor,
        workspaceId: execWorkspaceId,
        principalId: operatorActor.principalId,
      });

    const polled = await pollConnectorCommands({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      waitMs: 0,
      limit: 10,
    });
    expect(polled.commands.find((c) => c.runId === withdrawnRun.run.id)).toBeUndefined();

    const commandRow = await rawQuery(
      `SELECT state, error_code FROM collab_connector_commands WHERE run_id = $1 ORDER BY created_at LIMIT 1`,
      [withdrawnRun.run.id],
    );
    expect(commandRow[0].state).toBe('cancelled');
    expect(commandRow[0].error_code).toBe('authorization_withdrawn');

    // Truthful history: the queued run is preserved, no fallback run created.
    const runs = await rawQuery(`SELECT count(*)::int AS n FROM collab_runs WHERE task_id = $1`, [
      withdrawnTask.id,
    ]);
    expect(runs[0].n).toBe(1);
    } finally {
      // Restore the operator so later suites see a stable fixture.
      const role = await rawQuery(
        `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'operator'`,
        [execWorkspaceId],
      );
      await rawQuery(
        `INSERT INTO collab_memberships (workspace_id, principal_id, role_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [execWorkspaceId, operatorActor.principalId, role[0].id],
      );
    }
  });

  it('records ambiguous, never an accepted grant, when authorization dies after delivery', async () => {
    // Manager (still authorized) queues a prompt on the primary session, PC
    // claims it, THEN the actor is disabled — the ack must not confirm.
    const runId = global.__launchRunId;
    const sessionId = (
      await rawQuery(`SELECT id FROM collab_sessions WHERE run_id = $1 ORDER BY created_at LIMIT 1`, [runId])
    )[0].id;
    const queued = await submitSessionCommand({
      actor: operatorActor,
      sessionId,
      idempotencyKey: 'idem-withdraw-prompt',
      command: { kind: 'prompt', text: 'in flight', behavior: 'steer' },
    });
    const delivered = await pollConnectorCommands({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      waitMs: 0,
      limit: 10,
    });
    expect(delivered.commands.find((c) => c.id === queued.commandId)).toBeDefined();

    // Disable the PROMPT ORIGINATOR (operator submitted this command).
    const disabled = await rawQuery(
      `UPDATE collab_principals SET disabled_at = now() WHERE id = $1 AND disabled_at IS NULL RETURNING id`,
      [operatorActor.principalId],
    );
    expect(disabled).toHaveLength(1);
    try {
      const ack = await ackConnectorCommand({
        token: hostToken,
        connectorSessionId: connector.connectorSessionId,
        leaseEpoch: connector.leaseEpoch,
        commandId: queued.commandId,
        state: 'accepted',
      });
      expect(ack.state).toBe('ambiguous');
      const row = await rawQuery(`SELECT state, error_code FROM collab_connector_commands WHERE id = $1`, [queued.commandId]);
      expect(row[0].state).toBe('ambiguous');
      expect(row[0].error_code).toBe('authorization_withdrawn');
    } finally {
      await rawQuery(`UPDATE collab_principals SET disabled_at = NULL WHERE id = $1`, [operatorActor.principalId]);
    }
  });

  it('consumes a replayed pending batch after a lost ack, then flows new events', async () => {
    const runId = (await listCollabRuns({ actor: managerActor, taskId })).runs[0].id;
    const sessionId = (
      await rawQuery(`SELECT id FROM collab_sessions WHERE run_id = $1 ORDER BY created_at LIMIT 1`, [runId])
    )[0].id;
    const base = { token: hostToken, connectorSessionId: connector.connectorSessionId, leaseEpoch: connector.leaseEpoch };

    const first = await submitConnectorObservations({
      ...base,
      events: [
        { eventId: 'reconnect-1', runId, sessionId, observedAt: new Date().toISOString(), kind: 'timeline', payload: { seq: 1 }, providerCursor: { epoch: 'rz', seq: '1' } },
        { eventId: 'reconnect-2', runId, sessionId, observedAt: new Date().toISOString(), kind: 'timeline', payload: { seq: 2 }, providerCursor: { epoch: 'rz', seq: '2' } },
      ],
    });
    expect(first.acceptedEventIds).toEqual(['reconnect-1', 'reconnect-2']);

    // Lost ack: the SAME events are resent verbatim → consumed again (pending
    // set drains) without duplicate rows or re-projection.
    const replay = await submitConnectorObservations({
      ...base,
      events: [
        { eventId: 'reconnect-1', runId, sessionId, observedAt: new Date().toISOString(), kind: 'timeline', payload: { seq: 1 }, providerCursor: { epoch: 'rz', seq: '1' } },
        { eventId: 'reconnect-2', runId, sessionId, observedAt: new Date().toISOString(), kind: 'timeline', payload: { seq: 2 }, providerCursor: { epoch: 'rz', seq: '2' } },
      ],
    });
    expect(replay.acceptedEventIds).toEqual(['reconnect-1', 'reconnect-2']);

    const rows = await rawQuery(
      `SELECT count(*)::int AS n FROM collab_connector_observations WHERE event_id IN ('reconnect-1','reconnect-2')`,
    );
    expect(rows[0].n).toBe(2);

    // A CHANGED payload under the same eventId is rejected, never smuggled.
    const forged = await submitConnectorObservations({
      ...base,
      events: [
        { eventId: 'reconnect-1', runId, sessionId, observedAt: new Date().toISOString(), kind: 'timeline', payload: { seq: 999 }, providerCursor: { epoch: 'rz', seq: '1' } },
      ],
    });
    expect(forged.rejectedEventIds).toEqual(['reconnect-1']);

    // New events still flow (pending set was not blocked).
    const fresh = await submitConnectorObservations({
      ...base,
      events: [
        { eventId: 'reconnect-3', runId, sessionId, observedAt: new Date().toISOString(), kind: 'timeline', payload: { seq: 3 }, providerCursor: { epoch: 'rz', seq: '3' } },
      ],
    });
    expect(fresh.acceptedEventIds).toEqual(['reconnect-3']);
  });

  it('merges partial session bindings and never lets a summary session finish the run', async () => {
    // Fresh task+run: the shared exec task carries older queued sessions that
    // would poison the work-session aggregate.
    const mergeTask = await createCollabTask({ actor: managerActor, projectId, title: 'Merge isolation task' });
    const run = await startCollabRun({
      actor: operatorActor,
      taskId: mergeTask.id,
      expectedVersion: 1,
      idempotencyKey: 'idem-merge-1',
      mappingId,
      profileId: 'ai3-coder',
      instructions: 'merge isolation',
    });
    const runId = run.run.id;
    const workSession = (
      await rawQuery(`SELECT id FROM collab_sessions WHERE run_id = $1 AND role = 'work' ORDER BY created_at LIMIT 1`, [runId])
    )[0].id;
    const summarySession = (
      await rawQuery(`INSERT INTO collab_sessions (run_id, title, role) VALUES ($1, 'Summary', 'summary') RETURNING id`, [runId])
    )[0].id;
    const base = { token: hostToken, connectorSessionId: connector.connectorSessionId, leaseEpoch: connector.leaseEpoch };

    // thread_started: providerSessionId only — must not wipe the agent ID.
    await rawQuery(`UPDATE collab_sessions SET paseo_agent_id = 'agent-full-1' WHERE id = $1`, [workSession]);
    await submitConnectorObservations({
      ...base,
      events: [
        { eventId: 'bind-1', runId, sessionId: workSession, observedAt: new Date().toISOString(), kind: 'session_bound', payload: { providerSessionId: 'prov-1' } },
        { eventId: 'work-run-1', runId, sessionId: workSession, observedAt: new Date().toISOString(), kind: 'state', payload: { state: 'running' }, providerCursor: { epoch: 'rf', seq: '1' } },
      ],
    });
    const work = await rawQuery(`SELECT paseo_agent_id, provider_session_id, state FROM collab_sessions WHERE id = $1`, [workSession]);
    expect(work[0].paseo_agent_id).toBe('agent-full-1');
    expect(work[0].provider_session_id).toBe('prov-1');

    // Summary session goes idle: the run must STILL be running (primary work).
    await submitConnectorObservations({
      ...base,
      events: [
        { eventId: 'summary-idle-1', runId, sessionId: summarySession, observedAt: new Date().toISOString(), kind: 'state', payload: { state: 'idle' }, providerCursor: { epoch: 'rf', seq: '2' } },
      ],
    });
    const runRow = await rawQuery(`SELECT state FROM collab_runs WHERE id = $1`, [runId]);
    expect(runRow[0].state).toBe('running');

    // Primary work session goes idle → only then the run is idle.
    await submitConnectorObservations({
      ...base,
      events: [
        { eventId: 'work-idle-1', runId, sessionId: workSession, observedAt: new Date().toISOString(), kind: 'state', payload: { state: 'idle' }, providerCursor: { epoch: 'rf', seq: '3' } },
      ],
    });
    const runAfter = await rawQuery(`SELECT state FROM collab_runs WHERE id = $1`, [runId]);
    expect(runAfter[0].state).toBe('idle');
  });

  it('re-delivers an ACCEPTED command whose response was lost (durable resume)', { timeout: 15_000 }, async () => {
    // Fresh task+run: one launch, delivered, acked accepted — then the HTTP
    // response is "lost". The next poll re-delivers the SAME command id with
    // the SAME payload; never a new command or new run.
    const resumeTask = await createCollabTask({ actor: managerActor, projectId, title: 'Resume task' });
    const run = await startCollabRun({
      actor: operatorActor,
      taskId: resumeTask.id,
      expectedVersion: 1,
      idempotencyKey: 'idem-resume-1',
      mappingId,
      profileId: 'ai3-coder',
      instructions: 'resume flow',
    });

    const first = await pollConnectorCommands({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      waitMs: 0,
      limit: 5,
    });
    const launch = first.commands.find((c) => c.runId === run.run.id);
    expect(launch).toBeDefined();

    const acked = await ackConnectorCommand({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      commandId: launch.id,
      state: 'accepted',
    });
    expect(acked.state).toBe('accepted');

    // Response lost → connector polls again after the 5s accepted settle:
    // same command, same payload (C dedupes by id; never a new run).
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    const resumed = await pollConnectorCommands({
      token: hostToken,
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      waitMs: 0,
      limit: 5,
    });
    const redelivered = resumed.commands.find((c) => c.id === launch.id);
    expect(redelivered).toBeDefined();
    expect(redelivered.payload).toEqual(launch.payload);

    // Still exactly one launch command for this run — never a new one.
    const commandCount = await rawQuery(
      `SELECT count(*)::int AS n FROM collab_connector_commands WHERE run_id = $1 AND kind = 'launch'`,
      [run.run.id],
    );
    expect(commandCount[0].n).toBe(1);
    const runCount = await rawQuery(`SELECT count(*)::int AS n FROM collab_runs WHERE task_id = $1`, [resumeTask.id]);
    expect(runCount[0].n).toBe(1);
  });

  it('hides internal comments from plain collaborators, shows them to operators', async () => {
    const runId = (await listCollabRuns({ actor: managerActor, taskId })).runs[0].id;
    void runId;
    const task = await createCollabTask({ actor: managerActor, projectId, title: 'Comment task' });

    // Manager (internal.read) posts an internal + a client comment.
    await createCollabComment({ actor: managerActor, taskId: task.id, body: 'internal note', visibility: 'internal' });
    await createCollabComment({ actor: managerActor, taskId: task.id, body: 'client update', visibility: 'client' });

    // Operator sees both (internal.read).
    const operatorView = await listCollabComments({ actor: operatorActor, taskId: task.id });
    expect(operatorView.comments.map((c) => c.visibility).sort()).toEqual(['client', 'internal']);

    // A plain collaborator (task.read only, no internal.read) sees only client.
    const collabRole = await rawQuery(
      `SELECT id FROM collab_roles WHERE workspace_id = (SELECT workspace_id FROM collab_projects WHERE id = $1) AND name = 'collaborator'`,
      [projectId],
    );
    const reader = await rawQuery(
      `INSERT INTO collab_principals (display_name, email) VALUES ('Reader', 'reader@exec.test') RETURNING id, session_version`,
    );
    await rawQuery(
      `INSERT INTO collab_memberships (workspace_id, project_id, principal_id, role_id) VALUES ((SELECT workspace_id FROM collab_projects WHERE id = $1), $1, $2, $3)`,
      [projectId, reader[0].id, collabRole[0].id],
    );
    const readerView = await listCollabComments({
      actor: { principalId: reader[0].id, sessionVersion: reader[0].session_version },
      taskId: task.id,
    });
    expect(readerView.comments.map((c) => c.visibility)).toEqual(['client']);
    expect(JSON.stringify(readerView)).not.toContain('internal note');

    // A collaborator cannot POST internal comments at all.
    await expect(
      createCollabComment({
        actor: { principalId: reader[0].id, sessionVersion: reader[0].session_version },
        taskId: task.id,
        body: 'sneaky internal',
        visibility: 'internal',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('projects task events with visibility, persists read cursors, and scopes attention', async () => {
    const task = await createCollabTask({ actor: managerActor, projectId, title: 'Events task' });
    await createCollabComment({ actor: managerActor, taskId: task.id, body: 'client event', visibility: 'client' });
    await createCollabComment({ actor: managerActor, taskId: task.id, body: 'internal event', visibility: 'internal' });

    const operatorEvents = await listTaskEvents({ actor: managerActor, taskId: task.id });
    expect(operatorEvents.events.length).toBeGreaterThanOrEqual(3); // created + 2 comments
    expect(operatorEvents.events.some((e) => e.visibility === 'internal')).toBe(true);

    // Plain collaborator: client-only projection.
    const collabRole = await rawQuery(
      `SELECT id FROM collab_roles WHERE workspace_id = (SELECT workspace_id FROM collab_projects WHERE id = $1) AND name = 'collaborator'`,
      [projectId],
    );
    const reader = await rawQuery(
      `INSERT INTO collab_principals (display_name, email) VALUES ('Event Reader', 'event-reader@exec.test') RETURNING id, session_version`,
    );
    await rawQuery(
      `INSERT INTO collab_memberships (workspace_id, project_id, principal_id, role_id) VALUES ((SELECT workspace_id FROM collab_projects WHERE id = $1), $1, $2, $3)`,
      [projectId, reader[0].id, collabRole[0].id],
    );
    const readerActor = { principalId: reader[0].id, sessionVersion: reader[0].session_version };
    const readerEvents = await listTaskEvents({ actor: readerActor, taskId: task.id });
    expect(readerEvents.events.some((e) => e.visibility === 'internal')).toBe(false);
    expect(JSON.stringify(readerEvents)).not.toContain('internal event');

    // Read cursor persists.
    const lastEvent = readerEvents.events[readerEvents.events.length - 1];
    await markTaskRead({ actor: readerActor, taskId: task.id, eventId: lastEvent.id });
    const cursor = await rawQuery(
      `SELECT last_event_id FROM collab_read_cursors WHERE task_id = $1 AND principal_id = $2`,
      [task.id, reader[0].id],
    );
    expect(cursor[0].last_event_id).toBe(lastEvent.id);

    // Attention feed: scoped to internal.read projects, unresolved only.
    const attention = await listAttention({ actor: managerActor });
    expect(Array.isArray(attention.attention)).toBe(true);
  });

  it('keeps read cursors task-bound and monotonic, and clears only read updates', async () => {
    const task = await createCollabTask({ actor: managerActor, projectId, title: 'Read cursor safety' });
    const other = await createCollabTask({ actor: managerActor, projectId, title: 'Other read cursor' });
    await createCollabComment({ actor: operatorActor, taskId: task.id, body: 'first', visibility: 'client' });
    await createCollabComment({ actor: operatorActor, taskId: task.id, body: 'second', visibility: 'client' });
    const events = (await listTaskEvents({ actor: managerActor, taskId: task.id })).events;
    const comments = events.filter((event) => event.kind === 'comment_added');
    await markTaskRead({ actor: managerActor, taskId: task.id, eventId: comments[1].id });
    await markTaskRead({ actor: managerActor, taskId: task.id, eventId: comments[0].id });
    const cursor = await rawQuery('SELECT last_event_id FROM collab_read_cursors WHERE task_id=$1 AND principal_id=$2', [task.id, managerActor.principalId]);
    expect(cursor[0].last_event_id).toBe(comments[1].id);
    await expect(markTaskRead({ actor: managerActor, taskId: other.id, eventId: comments[1].id })).rejects.toMatchObject({ status: 404 });
    const attention = await listAttention({ actor: managerActor, taskId: task.id });
    expect(attention.attention).toEqual([]);
    await createCollabComment({ actor: operatorActor, taskId: task.id, body: 'new unread', visibility: 'client' });
    const unread = await listAttention({ actor: managerActor, taskId: task.id, limit: 1 });
    expect(unread.attention).toEqual([expect.objectContaining({ taskId: task.id, kind: 'unread', title: 'Read cursor safety', id: expect.any(String), createdAt: expect.any(String) })]);
  });

  it('continues an idle run with a frozen default session and reserves it against racing Start', async () => {
    const task = await createCollabTask({actor:managerActor,projectId,title:'Idle session continuation',description:'Keep the task context'});
    const started = await startCollabRun({actor:managerActor,taskId:task.id,expectedVersion:task.version,idempotencyKey:'idle-initial-start'});
    await submitConnectorObservations({token:hostToken,...connector,events:[{eventId:'idle-initial-turn',runId:started.run.id,sessionId:started.sessionId,kind:'state',observedAt:new Date().toISOString(),payload:{state:'idle'}}]});
    const added = await createRunSession({actor:managerActor,runId:started.run.id,idempotencyKey:'idle-add-session',title:'Second session',instructions:''});
    const command = (await rawQuery('SELECT payload FROM collab_connector_commands WHERE id=$1',[added.commandId]))[0];
    expect(command.payload).toMatchObject({profileId:'ai3-coder',repositoryKey:'fluent-io/fluent-flow',profileSnapshot:{provider:'omp'}});
    expect(command.payload.prompt).toContain('Idle session continuation');
    expect(command.payload.prompt).toContain('Keep the task context');
    expect((await getCollabRun(managerActor,started.run.id)).run.state).toBe('queued');
    await submitConnectorObservations({token:hostToken,...connector,events:[{eventId:'idle-second-turn',runId:started.run.id,sessionId:added.session.id,kind:'state',observedAt:new Date().toISOString(),payload:{state:'idle'}}]});
    const results=await Promise.allSettled([
      submitSessionCommand({actor:managerActor,sessionId:added.session.id,idempotencyKey:'idle-followup-race',command:{kind:'prompt',text:'Continue carefully',behavior:'steer'}}),
      startCollabRun({actor:managerActor,taskId:task.id,expectedVersion:task.version,idempotencyKey:'idle-start-race'}),
    ]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r=>r.status==='rejected' && r.reason.status===409)).toHaveLength(1);
    const active=await rawQuery("SELECT id FROM collab_runs WHERE task_id=$1 AND state IN ('queued','launching','running','needs_input','cancel_requested','reconciling')",[task.id]);
    expect(active).toHaveLength(1);
  });

  it('does not grant a demoted command originator access to internal results',async()=>{
    const task=await createCollabTask({actor:managerActor,projectId,title:'Command privacy'});
    const run=await startCollabRun({actor:operatorActor,taskId:task.id,expectedVersion:task.version,idempotencyKey:'privacy-command-start'});
    const command=await submitSessionCommand({actor:operatorActor,sessionId:run.sessionId,idempotencyKey:'privacy-command-prompt',command:{kind:'prompt',text:'Private instructions',behavior:'steer'}});
    const member=await rawQuery('SELECT id,role_id FROM collab_memberships WHERE principal_id=$1',[operatorActor.principalId]);
    const role=await rawQuery("SELECT id FROM collab_roles WHERE workspace_id=(SELECT workspace_id FROM collab_projects WHERE id=$1) AND name='collaborator'",[projectId]);
    try {
      await rawQuery('UPDATE collab_memberships SET role_id=$1 WHERE id=$2',[role[0].id,member[0].id]);
      await expect(getConnectorCommand(operatorActor,command.commandId)).rejects.toMatchObject({status:404});
    } finally { await rawQuery('UPDATE collab_memberships SET role_id=$1 WHERE id=$2',[member[0].role_id,member[0].id]); }
  });

  it('retains late observations without regressing projected usage or the current native plan',async()=>{
    const task=await createCollabTask({actor:managerActor,projectId,title:'Ordered observation projections'});
    const run=await startCollabRun({actor:managerActor,taskId:task.id,expectedVersion:task.version,idempotencyKey:'ordered-projection-run'});
    const event=(id,kind,payload,seq)=>({eventId:id,runId:run.run.id,sessionId:run.sessionId,observedAt:new Date().toISOString(),kind,payload,providerCursor:{epoch:'ordered-epoch',seq}});
    await submitConnectorObservations({token:hostToken,...connector,events:[event('ordered-usage-new','usage',{sampleKey:'ordered-turn',tokensIn:20},'10'),event('ordered-plan-new','state',{plan:{items:[{text:'Current plan',status:'completed'}]}},'10')]});
    await submitConnectorObservations({token:hostToken,...connector,events:[{eventId:'ordered-uncursored-state',runId:run.run.id,sessionId:run.sessionId,observedAt:new Date().toISOString(),kind:'state',payload:{state:'running'}}]});
    const late=await submitConnectorObservations({token:hostToken,...connector,events:[event('ordered-usage-old','usage',{sampleKey:'ordered-turn',tokensIn:5},'9'),event('ordered-plan-old','state',{plan:{items:[{text:'Old plan',status:'pending'}]}},'9')]});
    expect(late.acceptedEventIds).toHaveLength(2);
    const usage=await rawQuery('SELECT tokens_in FROM collab_usage_samples WHERE task_id=$1',[task.id]);
    expect(Number(usage[0].tokens_in)).toBe(20);
    const plans=await rawQuery('SELECT items FROM collab_workpad_plans WHERE task_id=$1',[task.id]);
    expect(plans).toHaveLength(1);
    expect(plans[0].items[0].text).toBe('Current plan');
  });

  it('processes the rest of a batch after a run-level state event',async()=>{
    const task=await createCollabTask({actor:managerActor,projectId,title:'Whole batch'});
    const run=await startCollabRun({actor:managerActor,taskId:task.id,expectedVersion:task.version,idempotencyKey:'whole-batch-run'});
    const result=await submitConnectorObservations({token:hostToken,...connector,events:[
      {eventId:'whole-run-state',runId:run.run.id,sessionId:null,kind:'state',observedAt:new Date().toISOString(),payload:{state:'launching'}},
      {eventId:'whole-usage',runId:run.run.id,sessionId:run.sessionId,kind:'usage',observedAt:new Date().toISOString(),payload:{sampleKey:'whole-batch-turn',tokensIn:3}},
    ]});
    expect(result.acceptedEventIds).toEqual(['whole-run-state','whole-usage']);
  });

  it('counts native session usage once and falls back to turns when a snapshot is unavailable', async () => {
    const workspace = (await rawQuery('SELECT workspace_id FROM collab_projects WHERE id=$1', [projectId]))[0];
    const project = await createCollabProject({ actor: managerActor, workspaceId: workspace.workspace_id, name: 'Usage aggregation' });
    await createProjectHostMapping({ actor: managerActor, projectId: project.id, hostId, repositoryKey: 'fluent-io/fluent-flow', profileIds: ['ai3-coder'], defaultProfileId: 'ai3-coder' });
    const task = await createCollabTask({ actor: managerActor, projectId: project.id, title: 'Usage source selection' });
    const run = await startCollabRun({ actor: managerActor, taskId: task.id, expectedVersion: task.version, idempotencyKey: 'usage-source-run' });
    const usage = (eventId, sampleKey, metrics) => ({ eventId, runId: run.run.id, sessionId: run.sessionId, kind: 'usage', observedAt: new Date().toISOString(), payload: { sampleKey, ...metrics } });
    const insights = () => getCollabProjectInsights({ actor: managerActor, projectId: project.id, from: new Date(Date.now()-3600000), to: new Date(Date.now()+10000) });

    await submitConnectorObservations({ token: hostToken, ...connector, events: [
      usage('usage-snapshot-unavailable', 'native-session-snapshot', { source: 'native_snapshot', scope: 'session', cumulative: true, tokensIn: null, tokensOut: null, costUsd: null, reason: 'unavailable' }),
    ] });
    expect((await insights()).usage).toMatchObject({ available: false, tokensIn: null, tokensOut: null, costUsd: null, reason: 'provider did not report token usage', coverage: { samples: 1, tokensIn: 0, tokensOut: 0, costUsd: 0 } });
    await submitConnectorObservations({ token: hostToken, ...connector, events: [
      usage('usage-turn-known', 'native-turn', { tokensIn: 10, tokensOut: 5, costUsd: 0.01 }),
    ] });
    expect((await insights()).usage).toMatchObject({ available: true, tokensIn: 10, tokensOut: 5, costUsd: 0.01, reason: null, coverage: { samples: 1, tokensIn: 1, tokensOut: 1, costUsd: 1 } });

    await submitConnectorObservations({ token: hostToken, ...connector, events: [
      usage('usage-snapshot-known', 'native-session-snapshot', { source: 'native_snapshot', scope: 'session', cumulative: true, tokensIn: 147, tokensOut: 4800, costUsd: 0.2 }),
    ] });
    expect((await insights()).usage).toMatchObject({ available: true, tokensIn: 147, tokensOut: 4800, costUsd: 0.2, reason: null, coverage: { samples: 1, tokensIn: 1, tokensOut: 1, costUsd: 1 } });
    expect(await rawQuery('SELECT id FROM collab_usage_samples WHERE task_id=$1', [task.id])).toHaveLength(2);
    expect(await rawQuery("SELECT id FROM collab_connector_observations WHERE run_id=$1 AND kind='usage'", [run.run.id])).toHaveLength(3);

    const second = await createRunSession({ actor: managerActor, runId: run.run.id, idempotencyKey: 'usage-second-session', title: 'Independent usage', instructions: 'Inspect usage sources' });
    await submitConnectorObservations({ token: hostToken, ...connector, events: [
      { ...usage('usage-second-turn', 'second-turn', { tokensIn: 3, tokensOut: 7, costUsd: 0.02 }), sessionId: second.session.id },
      usage('usage-snapshot-partial', 'native-session-snapshot', { source: 'native_snapshot', scope: 'session', cumulative: true, tokensIn: 200, tokensOut: null, costUsd: null }),
    ] });
    const combined = (await insights()).usage;
    expect(combined).toMatchObject({ tokensIn: 203, tokensOut: 7, costUsd: 0.02, coverage: { samples: 2, tokensIn: 2, tokensOut: 1, costUsd: 1 } });
    expect(combined.reason).toMatch(/partial/);
  });

  it('paginates same-batch timeline rows using ingestion time and row identity',async()=>{
    const task=await createCollabTask({actor:managerActor,projectId,title:'Timeline pagination'});
    const run=await startCollabRun({actor:managerActor,taskId:task.id,expectedVersion:task.version,idempotencyKey:'timeline-paging-run'});
    await submitConnectorObservations({token:hostToken,...connector,events:Array.from({length:6},(_,index)=>({eventId:`timeline-page-${index}`,runId:run.run.id,sessionId:run.sessionId,kind:'timeline',observedAt:'2026-01-01T00:00:00.000Z',payload:{text:`row ${index}`}}))});
    const first=await getSessionTimeline({actor:managerActor,sessionId:run.sessionId,limit:2});
    const second=await getSessionTimeline({actor:managerActor,sessionId:run.sessionId,limit:2,cursor:first.nextCursor});
    expect(second.entries).toHaveLength(2);
    expect(second.entries.every(row=>!first.entries.some(old=>old.eventId===row.eventId))).toBe(true);
    const third=await getSessionTimeline({actor:managerActor,sessionId:run.sessionId,limit:2,cursor:second.nextCursor});
    expect(new Set([...first.entries,...second.entries,...third.entries].map(row=>row.eventId)).size).toBe(6);
    expect(third.nextCursor).toBeNull();
    expect(third.cursor).toEqual(expect.any(String));
    await submitConnectorObservations({token:hostToken,...connector,events:[{eventId:'timeline-live-tail',runId:run.run.id,sessionId:run.sessionId,kind:'timeline',observedAt:new Date().toISOString(),payload:{text:'live tail'}}]});
    const tail=await getSessionTimeline({actor:managerActor,sessionId:run.sessionId,limit:2,cursor:third.cursor});
    expect(tail.entries.map(row=>row.eventId)).toEqual(['timeline-live-tail']);
  });
});
