import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

// Real app + real DB + real protocol. Dynamic imports follow the repo's
// vi.mock hoisting convention and env ordering (db pool resolves at import).
vi.mock('../../src/tracing.cjs', () => ({}));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

const { resolveCollabTestDatabaseUrl, resetCollabSchema, seedLegacyUser, seedLegacyOrgMembership } =
  await import('../helpers/collab-db.js');
process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();

const TEST_AUTH_SECRET = 'collab-test-secret-0123456789abcdef0123456789abcdef';
const { signCollaborationActor } = await import('@fluent-flow/db');
const { createApp } = await import('../../src/app.js');

function actorHeader(p) {
  return signCollaborationActor({ principalId: p.id, sessionVersion: p.sessionVersion }, TEST_AUTH_SECRET);
}

describe('A3 protocol over real HTTP (run start, connector loop, host truth)', () => {
  let server;
  let baseUrl;
  let manager;
  let operator;
  let taskId;
  let projectId;
  let hostToken;
  let connector;

  async function collab(method, path, { actor, body, headers } = {}) {
    const h = { 'x-fluent-flow-actor': actorHeader(actor), ...(headers ?? {}) };
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(`${baseUrl}/api/collab/v1${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function connectorCall(method, path, body) {
    const res = await fetch(`${baseUrl}/api/connector/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    const { runMigrations, ensureGithubPrincipal, bootstrapCollaborationWorkspace, createCollabProject, createCollabTask, createExecutionHost, createProjectHostMapping } =
      await import('@fluent-flow/db');
    await runMigrations();

    const legacyAdmin = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9601, login: 'proto-owner' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, legacyAdmin, 'proto-org', 'admin');
    const principal = await ensureGithubPrincipal({
      legacyUserId: legacyAdmin,
      displayName: 'Proto Owner',
      email: 'proto-owner@example.test',
    });
    manager = { id: principal.id, sessionVersion: principal.sessionVersion };
    const ws = await bootstrapCollaborationWorkspace({
      actor: { principalId: manager.id, sessionVersion: manager.sessionVersion },
      legacyOrgId: 'proto-org',
      name: 'Proto Client',
      idempotencyKey: 'proto-ws-01',
    });
    const project = await createCollabProject({
      actor: { principalId: manager.id, sessionVersion: manager.sessionVersion },
      workspaceId: ws.id,
      name: 'Proto P1',
    });
    projectId = project.id;
    taskId = (
      await createCollabTask({
        actor: { principalId: manager.id, sessionVersion: manager.sessionVersion },
        projectId,
        title: 'Protocol task',
      })
    ).id;

    const host = await createExecutionHost({
      actor: { principalId: manager.id, sessionVersion: manager.sessionVersion },
      name: 'Proto PC',
    });
    hostToken = host.token;
    await createProjectHostMapping({
      actor: { principalId: manager.id, sessionVersion: manager.sessionVersion },
      projectId,
      hostId: host.id,
      repositoryKey: 'proto/repo',
      profileIds: ['ai3-coder'],
      defaultProfileId: 'ai3-coder',
    });

    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const registered = await connectorCall('POST', '/register', {
      instanceId: 'proto-1',
      protocolVersion: 1,
      sdkVersion: '0.12.0',
      daemonVersion: '1.0.0',
      capabilities: {},
      catalog: { repositories: [{ key: 'proto/repo' }], profiles: [{ id: 'ai3-coder', provider: 'omp' }] },
    });
    expect(registered.status).toBe(200);
    connector = registered.body.data;
  });

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    const { closePool } = await import('@fluent-flow/db');
    await closePool();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('starts a run over HTTP idempotently (202 queued; replay 200 same run)', async () => {
    const first = await collab('POST', `/tasks/${taskId}/runs`, {
      actor: manager,
      headers: { 'idempotency-key': 'http-run-key-1' },
      body: { expectedVersion: 1, instructions: 'Build it', profileId: 'ai3-coder' },
    });
    expect(first.status).toBe(202);
    expect(first.body.data.run.state).toBe('queued');
    expect(first.body.data.run.hostName).toBe('Proto PC');
    global.__protoRunId = first.body.data.run.id;
    global.__protoSessionId = first.body.data.sessionId;

    const replay = await collab('POST', `/tasks/${taskId}/runs`, {
      actor: manager,
      headers: { 'idempotency-key': 'http-run-key-1' },
      body: { expectedVersion: 1, instructions: 'Build it', profileId: 'ai3-coder' },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data.created).toBe(false);
    expect(replay.body.data.run.id).toBe(global.__protoRunId);
  });

  it('delivers exactly one launch command and accepts the ack', async () => {
    const poll = await connectorCall('POST', '/poll', {
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      waitMs: 0,
      limit: 5,
    });
    expect(poll.status).toBe(200);
    const launches = poll.body.data.commands.filter((c) => c.kind === 'launch');
    expect(launches).toHaveLength(1);
    expect(launches[0].payload.labels['fluent-flow.run']).toBe(global.__protoRunId);
    expect(launches[0].payload.workspace.baseRef).toBe('main');
    global.__protoReportingCredential = launches[0].payload.reportingCredential;

    const ack = await connectorCall('POST', `/commands/${launches[0].id}/ack`, {
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      state: 'applied',
      result: { started: true },
    });
    expect(ack.status).toBe(200);
  });

  it('binds the workspace and projects run/host truth to the operator', async () => {
    await connectorCall('POST', '/observations', {
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      events: [
        {
          eventId: 'proto-bound-1',
          runId: global.__protoRunId,
          sessionId: null,
          observedAt: new Date().toISOString(),
          kind: 'workspace_bound',
          payload: { workspaceId: 'paseo-ws-proto' },
        },
        {
          eventId: 'proto-state-1',
          runId: global.__protoRunId,
          sessionId: global.__protoSessionId,
          observedAt: new Date().toISOString(),
          kind: 'state',
          payload: { state: 'running' },
          providerCursor: { epoch: 'pe', seq: '1' },
        },
      ],
    });
    const detail = await collab('GET', `/runs/${global.__protoRunId}`, { actor: manager });
    expect(detail.status).toBe(200);
    expect(detail.body.data.run.state).toBe('running');
    expect(detail.body.data.run.hostName).toBe('Proto PC');
    expect(detail.body.data.run.workspaceId).toBe('paseo-ws-proto');
    expect(detail.body.data.sessions).toHaveLength(1);
    const card = await collab('GET', `/tasks/${taskId}`, { actor: manager });
    expect(card.body.data.execution).toMatchObject({ latestRun: { id: global.__protoRunId, state: 'running' }, hostReachability: 'online' });
    expect(JSON.stringify(card.body.data.execution)).not.toContain('Build it');
  });

  it('queues a follow-up prompt with run.steer and surfaces the command state', async () => {
    const prompt = await collab('POST', `/sessions/${global.__protoSessionId}/commands`, {
      actor: manager,
      headers: { 'idempotency-key': 'http-prompt-key-1' },
      body: { kind: 'prompt', text: 'continue with tests', behavior: 'steer' },
    });
    expect(prompt.status).toBe(202);
    global.__protoCommandId = prompt.body.data.commandId;

    const replay = await collab('POST', `/sessions/${global.__protoSessionId}/commands`, {
      actor: manager,
      headers: { 'idempotency-key': 'http-prompt-key-1' },
      body: { kind: 'prompt', text: 'continue with tests', behavior: 'steer' },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data.commandId).toBe(global.__protoCommandId);

    const state = await collab('GET', `/commands/${global.__protoCommandId}`, { actor: manager });
    expect(state.status).toBe(200);
    expect(state.body.data.state).toBe('pending');
  });

  it('stage edit over HTTP stays on run.steer and leaves task status untouched', async () => {
    const run = (await collab('GET', `/runs/${global.__protoRunId}`, { actor: manager })).body.data.run;
    const patched = await collab('PATCH', `/runs/${global.__protoRunId}`, {
      actor: manager,
      body: { expectedVersion: run.version, stage: 'development' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data.stage).toBe('development');

    const task = await collab('GET', `/tasks/${taskId}`, { actor: manager });
    expect(task.body.data.status).toBe('in_progress');
  });

  it('Ready move creates zero commands', async () => {
    const second = await collab('POST', `/projects/${projectId}/tasks`, {
      actor: manager,
      body: { title: 'Ready-only task' },
    });

    // Drain any prior queued work (deliver + ack) so the assertion below is
    // specifically about the Ready move producing nothing new.
    for (;;) {
      const poll = await connectorCall('POST', '/poll', {
        connectorSessionId: connector.connectorSessionId,
        leaseEpoch: connector.leaseEpoch,
        waitMs: 0,
        limit: 10,
      });
      if (poll.body.data.commands.length === 0) break;
      for (const command of poll.body.data.commands) {
        await connectorCall('POST', `/commands/${command.id}/ack`, {
          connectorSessionId: connector.connectorSessionId,
          leaseEpoch: connector.leaseEpoch,
          state: 'applied',
        });
      }
    }

    const me = await collab('GET','/me',{actor:manager});
    const liveProject=me.body.data.workspaces.flatMap(w=>w.projects).find(p=>p.id===projectId);
    const moved = await collab('POST', `/tasks/${second.body.data.id}/moves`, {
      actor: manager,
      body: { expectedVersion: second.body.data.version, expectedBoardVersion: liveProject.boardVersion, status: 'ready', beforeTaskId: null, afterTaskId: null },
    });
    expect(moved.status).toBe(200);

    const poll = await connectorCall('POST', '/poll', {
      connectorSessionId: connector.connectorSessionId,
      leaseEpoch: connector.leaseEpoch,
      waitMs: 0,
      limit: 10,
    });
    expect(poll.body.data.commands).toHaveLength(0);
  });

  it('streams later scoped updates over one open connection and closes on membership revocation', async () => {
    const { getPool } = await import('@fluent-flow/db');
    const pool = getPool();
    const task = await collab('POST', `/projects/${projectId}/tasks`, { actor: manager, body: { title: 'Live task' } });
    const { rows: people } = await pool.query("INSERT INTO collab_principals(display_name) VALUES('Live Reader') RETURNING id,session_version");
    const reader = { id: people[0].id, sessionVersion: people[0].session_version };
    await pool.query(`INSERT INTO collab_memberships(workspace_id,project_id,principal_id,role_id)
      SELECT p.workspace_id,p.id,$2,role.id FROM collab_projects p JOIN collab_roles role ON role.workspace_id=p.workspace_id
      WHERE p.id=$1 AND role.name='collaborator'`, [projectId, reader.id]);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5000);
    try {
      const response = await fetch(`${baseUrl}/api/collab/v1/events?taskId=${task.body.data.id}`, {
        headers: { 'x-fluent-flow-actor': actorHeader(reader), accept: 'text/event-stream' }, signal: abort.signal,
      });
      expect(response.status).toBe(200);
      const stream = response.body.getReader();
      let text = '';
      const readUntil = async (part) => {
        while (!text.includes(part)) {
          const chunk = await stream.read();
          if (chunk.done) throw new Error(`Stream closed before ${part}`);
          text += new TextDecoder().decode(chunk.value);
        }
      };
      await readUntil(': connected');
      const comment = await collab('POST', `/tasks/${task.body.data.id}/comments`, { actor: manager, body: { body: 'added after subscription', visibility: 'client' } });
      await readUntil(comment.body.data.id);
      expect(text).toContain('event: update');
      await pool.query('DELETE FROM collab_memberships WHERE principal_id=$1', [reader.id]);
      await readUntil('event: access_revoked');
      expect((await stream.read()).done).toBe(true);
    } finally {
      clearTimeout(timeout);
      abort.abort();
    }
  });

  it('shows current pending requests, omits resolutions, and keeps unresolved attention after marking read', async () => {
    const stamp = Date.now();
    const events = [
      { eventId: 'question-a', observedAt: new Date(stamp).toISOString(), payload: { attention: 'permission', permissionKind: 'question', requestId: 'request-a', promptText: 'Choose a' } },
      { eventId: 'question-b', observedAt: new Date(stamp + 1).toISOString(), payload: { attention: 'permission', permissionKind: 'tool', requestId: 'request-b', promptText: 'Allow b' } },
      { eventId: 'resolution-a', observedAt: new Date(stamp + 2).toISOString(), payload: { attention: 'permission_resolved', requestId: 'request-a' } },
    ].map((event) => ({ ...event, runId: global.__protoRunId, sessionId: global.__protoSessionId, kind: 'attention' }));
    const observed = await connectorCall('POST', '/observations', { connectorSessionId: connector.connectorSessionId, leaseEpoch: connector.leaseEpoch, events });
    expect(observed.status).toBe(200);
    const feed = await collab('GET', `/attention?taskId=${taskId}&limit=1`, { actor: manager });
    expect(feed.status).toBe(200);
    expect(feed.body.data[0]).toMatchObject({ kind: 'permission', taskId, requestId: 'request-b' });
    await collab('POST', `/tasks/${taskId}/read-cursor`, { actor: manager, body: { eventId: feed.body.data[0].id } });
    const pending = await collab('GET', `/sessions/${global.__protoSessionId}/pending-request`, { actor: manager });
    expect(pending.body.data).toMatchObject({ kind: 'permission', requestId: 'request-b' });
    const stillPending = await collab('GET', `/attention?taskId=${taskId}`, { actor: manager });
    expect(stillPending.body.data.some((item) => item.requestId === 'request-b')).toBe(true);
    expect(stillPending.body.data.some((item) => item.requestId === 'request-a')).toBe(false);
    if (feed.body.nextCursor) {
      const page = await collab('GET', `/attention?taskId=${taskId}&cursor=${feed.body.nextCursor}`, { actor: manager });
      expect(page.status).toBe(200);
    }
  });

  it('atomically projects bound native plan, usage, progress, summary and HEAD exactly once', async () => {
    const { getPool } = await import('@fluent-flow/db');
    const summarySession=await getPool().query(`INSERT INTO collab_sessions(run_id,title,role) VALUES($1,'Summary fixture','summary') RETURNING id`,[global.__protoRunId]);
    const observe = (events) => connectorCall('POST', '/observations', { connectorSessionId: connector.connectorSessionId, leaseEpoch: connector.leaseEpoch, events });
    const event = (id, kind, payload) => ({ eventId:id,runId:global.__protoRunId,sessionId:global.__protoSessionId,observedAt:new Date().toISOString(),kind,payload });
    const events = [
      event('native-plan','state',{ plan: { items: [{text:'Write the regression',status:'completed'},{text:'Implement the change',status:'in_progress'}] } }),
      event('native-usage','usage',{sampleKey:'turn-native',tokensIn:7,tokensOut:null,costUsd:null,reason:'Output unavailable'}),
      event('native-head','state',{headCommit:'a'.repeat(40),dirty:true,progress:{text:'Running tests',percent:null}}),
      event('native-summary','summary',{body:'One regression added.',model:'configured-summary',sourceCursor:{epoch:'native',seq:'3'}}),
    ];
    events[3].sessionId=summarySession.rows[0].id;
    const result = await observe(events);
    expect(result.status).toBe(200);
    expect(result.body.data.acceptedEventIds).toHaveLength(4);
    const pool = getPool();
    const plan = await pool.query('SELECT * FROM collab_workpad_plans WHERE task_id=$1', [taskId]);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({run_id:global.__protoRunId,session_id:global.__protoSessionId,provenance:'agent'});
    const usage = await pool.query('SELECT * FROM collab_usage_samples WHERE task_id=$1', [taskId]);
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({tokens_in:'7',tokens_out:null});
    const run = (await collab('GET', `/runs/${global.__protoRunId}`, {actor:manager})).body.data.run;
    expect(run).toMatchObject({headCommit:'a'.repeat(40),dirty:true,progress:{text:'Running tests',percent:null}});
    expect((await pool.query('SELECT id FROM collab_summaries WHERE task_id=$1', [taskId])).rows).toHaveLength(1);
    await observe(events);
    expect((await pool.query('SELECT id FROM collab_workpad_plans WHERE task_id=$1', [taskId])).rows).toHaveLength(1);
    const invalid = await observe([event('rollback-usage','usage',{sampleKey:'rollback',tokensIn:8}),event('invalid-plan','state',{plan:{items:[{text:'',status:'pending'}]}})]);
    expect(invalid.status).toBe(400);
    expect((await pool.query("SELECT id FROM collab_connector_observations WHERE event_id='rollback-usage'")).rows).toHaveLength(0);
    expect((await pool.query("SELECT id FROM collab_usage_samples WHERE provider_turn_id='rollback'")).rows).toHaveLength(0);
  });

  it('authenticates the delivered MCP credential and forces bound agent reporting provenance', async () => {
    const response = await fetch(`${baseUrl}/mcp/collab`, {
      method:'POST', headers:{authorization:`Bearer ${global.__protoReportingCredential}`,'content-type':'application/json',accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'collaboration_report_check',arguments:{name:'Native regression',command:'npm test',status:'passed',commit:'a'.repeat(40),exitCode:0}}}),
    });
    expect(response.status).toBe(200);
    const wire = await response.text();
    const result = wire.startsWith('data:') ? JSON.parse(wire.split('data: ')[1].trim()) : JSON.parse(wire);
    expect(result.result.isError).not.toBe(true);
    const {getPool} = await import('@fluent-flow/db');
    const evidence = await getPool().query(`SELECT evidence.* FROM collab_check_evidence evidence JOIN collab_checks c ON c.id=evidence.check_id WHERE c.task_id=$1 AND c.name='Native regression'`,[taskId]);
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]).toMatchObject({run_id:global.__protoRunId,session_id:global.__protoSessionId,provenance:'agent'});
  });

  it('keeps human tokens project scoped and agent tokens reporting-only across application restart', async () => {
    const {getPool,createCollabProject,createCollabTask} = await import('@fluent-flow/db');
    const workspace = await getPool().query('SELECT workspace_id FROM collab_projects WHERE id=$1',[projectId]);
    const actor={principalId:manager.id,sessionVersion:manager.sessionVersion};
    const foreignProject=await createCollabProject({actor,workspaceId:workspace.rows[0].workspace_id,name:'Other project'});
    const foreignTask=await createCollabTask({actor,projectId:foreignProject.id,title:'Other project secret'});
    const issued=await collab('POST',`/projects/${projectId}/tokens`,{actor:manager,body:{name:'Local tool'}});
    expect(issued.status).toBe(201);
    const humanToken=issued.body.data.token;
    const rpc=async(token,name,args)=>{
      const response=await fetch(`${baseUrl}/mcp/collab`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
      return {status:response.status,body:await response.json()};
    };
    expect((await rpc(humanToken,'collaboration_get_task',{taskId})).body.result.isError).not.toBe(true);
    const foreign=await rpc(humanToken,'collaboration_get_task',{taskId:foreignTask.id});
    expect(foreign.body.result.isError).toBe(true);
    expect(JSON.stringify(foreign.body)).not.toContain('Other project secret');
    expect((await rpc(global.__protoReportingCredential,'collaboration_get_task',{taskId:foreignTask.id})).body.result.isError).toBe(true);
    expect((await rpc(global.__protoReportingCredential,'collaboration_start_run',{taskId,expectedVersion:1,idempotencyKey:'agent-start-denied'})).body.result.isError).toBe(true);
    const accept=await rpc(global.__protoReportingCredential,'collaboration_accept_delivery',{taskId});
    expect(accept.body.error || accept.body.result?.isError).toBeTruthy();
    await new Promise(resolve=>server.close(resolve));
    await new Promise(resolve=>{server=createApp().listen(0,'127.0.0.1',resolve);});
    baseUrl=`http://127.0.0.1:${server.address().port}`;
    expect((await rpc(global.__protoReportingCredential,'collaboration_get_task',{taskId})).body.result.isError).not.toBe(true);
    const publicTokens=await collab('GET',`/projects/${projectId}/tokens`,{actor:manager});
    expect(JSON.stringify(publicTokens)).not.toContain(humanToken);
    await collab('POST',`/tokens/${issued.body.data.id}/revoke`,{actor:manager});
    expect((await rpc(humanToken,'collaboration_get_task',{taskId})).status).toBe(401);
  });

  it('projects failed and ambiguous launch outcomes onto the task with explicit same-command reconciliation', async () => {
    const make=async(title,key)=>{
      const task=await collab('POST',`/projects/${projectId}/tasks`,{actor:manager,body:{title}});
      const start=await collab('POST',`/tasks/${task.body.data.id}/runs`,{actor:manager,headers:{'idempotency-key':key},body:{expectedVersion:task.body.data.version}});
      const poll=await connectorCall('POST','/poll',{...connector,waitMs:0,limit:10});
      const command=poll.body.data.commands.find(c=>c.runId===start.body.data.run.id);
      expect(command).toBeTruthy();
      return {taskId:task.body.data.id,runId:start.body.data.run.id,commandId:command.id};
    };
    const failed=await make('Failed launch','failed-launch-http');
    expect((await connectorCall('POST',`/commands/${failed.commandId}/ack`,{...connector,state:'failed',errorCode:'profile_unavailable'})).status).toBe(200);
    const failedCard=await collab('GET',`/tasks/${failed.taskId}`,{actor:manager});
    expect(failedCard.body.data.execution).toMatchObject({latestRun:{state:'failed'},attentionCount:1});
    expect(failedCard.body.data.status).toBe('backlog');
    const ambiguous=await make('Ambiguous launch','ambiguous-launch-http');
    await connectorCall('POST',`/commands/${ambiguous.commandId}/ack`,{...connector,state:'ambiguous',errorCode:'prompt_uncertain'});
    const held=await collab('GET',`/tasks/${ambiguous.taskId}`,{actor:manager});
    expect(held.body.data.execution).toMatchObject({latestRun:{state:'reconciling'},attentionCount:1});
    const heldRun=await collab('GET',`/runs/${ambiguous.runId}`,{actor:manager});
    expect(heldRun.body.data.unresolvedCommands).toEqual(expect.arrayContaining([expect.objectContaining({id:ambiguous.commandId,state:'ambiguous',safeActions:['redeliver','cancel']})]));
    expect(JSON.stringify(heldRun.body.data.unresolvedCommands)).not.toContain('reportingCredential');
    const redelivery=await collab('POST',`/commands/${ambiguous.commandId}/reconcile`,{actor:manager,body:{action:'redeliver'}});
    expect(redelivery.status).toBe(200);
    const replay=await connectorCall('POST','/poll',{...connector,waitMs:0,limit:10});
    expect(replay.body.data.commands.find(c=>c.runId===ambiguous.runId).id).toBe(ambiguous.commandId);
    await connectorCall('POST',`/commands/${ambiguous.commandId}/ack`,{...connector,state:'ambiguous'});
    await collab('POST',`/commands/${ambiguous.commandId}/reconcile`,{actor:manager,body:{action:'cancel'}});
    const retained=await collab('GET',`/runs/${ambiguous.runId}`,{actor:manager});
    expect(retained.body.data.run.state).toBe('reconciling');
  });

  it('lists members only at the administered scope',async()=>{
    const members=await collab('GET',`/projects/${projectId}/members`,{actor:manager});
    expect(members.status).toBe(200);
    expect(members.body.data).toEqual(expect.arrayContaining([expect.objectContaining({principalId:manager.id,displayName:'Proto Owner',roleName:'manager'})]));
  });

  it('serves safe assignees and persists edit/move events for live boards',async()=>{
    const assignees=await collab('GET',`/projects/${projectId}/assignees`,{actor:manager});
    expect(assignees.status).toBe(200);
    expect(assignees.body.data).toContainEqual({id:manager.id,displayName:'Proto Owner'});
    expect(JSON.stringify(assignees.body)).not.toContain('email');
    const task=await collab('POST',`/projects/${projectId}/tasks`,{actor:manager,body:{title:'Live edits'}});
    const patched=await collab('PATCH',`/tasks/${task.body.data.id}`,{actor:manager,body:{expectedVersion:task.body.data.version,title:'Updated live',assigneeId:manager.id}});
    expect(patched.status).toBe(200);
    const me=await collab('GET','/me',{actor:manager});
    const project=me.body.data.workspaces.flatMap(w=>w.projects).find(p=>p.id===projectId);
    const moved=await collab('POST',`/tasks/${task.body.data.id}/moves`,{actor:manager,body:{expectedVersion:patched.body.data.version,expectedBoardVersion:project.boardVersion,status:'ready',beforeTaskId:null,afterTaskId:null}});
    expect(moved.status).toBe(200);
    const events=await collab('GET',`/events?taskId=${task.body.data.id}`,{actor:manager});
    expect(events.body.data.map(e=>e.kind)).toEqual(['task_created','task_updated','task_moved']);
  });

  it('retains bound private agent artifacts, ideas and progress through MCP',async()=>{
    const rpc=async(name,args)=>{
      const response=await fetch(`${baseUrl}/mcp/collab`,{method:'POST',headers:{authorization:`Bearer ${global.__protoReportingCredential}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
      expect(response.status).toBe(200);return response.json();
    };
    const artifact=await rpc('collaboration_add_artifact',{name:'Agent note',kind:'text',direction:'output',content:'Private generated result',visibility:'client',provenance:'human'});
    expect(artifact.result.isError).not.toBe(true);
    const file=await rpc('collaboration_add_artifact',{name:'Generated file',kind:'file',direction:'output',reference:'greeting.txt',mediaType:'text/plain'});
    expect(file.result.isError).not.toBe(true);
    const dirtyCheck=await rpc('collaboration_report_check',{name:'Dirty capture',command:'npm test',status:'passed',commit:'a'.repeat(40),dirty:true,exitCode:0});
    expect(dirtyCheck.result.isError).not.toBe(true);
    const idea=await rpc('collaboration_propose_idea',{title:'A later improvement',body:'Do not execute this automatically'});
    expect(idea.result.isError).not.toBe(true);
    const progress=await rpc('collaboration_report_progress',{text:'Checking the final diff',percent:null});
    expect(progress.result?.isError).not.toBe(true);
    expect(progress.error).toBeUndefined();
    const {getPool}=await import('@fluent-flow/db');
    const row=(await getPool().query("SELECT run_id,session_id,visibility,provenance FROM collab_artifacts WHERE task_id=$1 AND name='Agent note'",[taskId])).rows[0];
    expect(row).toMatchObject({run_id:global.__protoRunId,session_id:global.__protoSessionId,visibility:'internal',provenance:'agent'});
    expect((await getPool().query(`SELECT e.dirty FROM collab_check_evidence e JOIN collab_checks c ON c.id=e.check_id WHERE c.task_id=$1 AND c.name='Dirty capture'`,[taskId])).rows[0].dirty).toBe(true);
    const run=(await collab('GET',`/runs/${global.__protoRunId}`,{actor:manager})).body.data.run;
    expect(run.progress).toMatchObject({text:'Checking the final diff',provenance:'agent'});
  });

  it('links existing delivery claims only when both legacy repository and project scopes allow it',async()=>{
    const {getPool}=await import('@fluent-flow/db');
    const pool=getPool();
    await pool.query("INSERT INTO repos(id,org_id,repo_full_name) VALUES('proto-repo','proto-org','proto/repo') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO orgs(id,name) VALUES('foreign-delivery-org','Foreign delivery') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO repos(id,org_id,repo_full_name) VALUES('foreign-delivery-repo','foreign-delivery-org','foreign/repo') ON CONFLICT DO NOTHING");
    const claim=await pool.query("INSERT INTO agent_claims(org_id,repo,pr_number,attempt,status) VALUES('proto-org','proto/repo',42,1,'pending') RETURNING id");
    const link=await collab('POST',`/tasks/${taskId}/delivery-links`,{actor:manager,body:{repo:'proto/repo',prNumber:42,claimId:claim.rows[0].id}});
    expect(link.status).toBe(201);
    const foreign=await collab('POST',`/tasks/${taskId}/delivery-links`,{actor:manager,body:{repo:'foreign/repo',prNumber:42}});
    expect(foreign.status).toBe(404);
    const mismatch=await collab('POST',`/tasks/${taskId}/delivery-links`,{actor:manager,body:{repo:'proto/repo',prNumber:99,claimId:claim.rows[0].id}});
    expect(mismatch.status).toBe(404);
    expect((await pool.query('SELECT status,session_id FROM agent_claims WHERE id=$1',[claim.rows[0].id])).rows[0]).toEqual({status:'pending',session_id:null});
    const linked=await collab('GET',`/tasks/${taskId}/delivery-links`,{actor:manager});
    expect(linked.body.data).toHaveLength(1);
    expect(linked.body.data[0]).toMatchObject({repo:'proto/repo',prNumber:42,claimId:claim.rows[0].id});
  });

  it('keeps observed cancellation terminal when a late cancellation intent arrives and resumes only on an explicit prompt',async()=>{
    const created=await collab('POST',`/projects/${projectId}/tasks`,{actor:manager,body:{title:'Native cancellation race'}});
    const started=await collab('POST',`/tasks/${created.body.data.id}/runs`,{actor:manager,headers:{'idempotency-key':'native-cancel-race-start'},body:{expectedVersion:created.body.data.version}});
    expect(started.status).toBe(202);
    const {run,sessionId}=started.body.data;
    const observe=async(eventId,state,seq,commandId)=>connectorCall('POST','/observations',{...connector,events:[{
      eventId,runId:run.id,sessionId,kind:'state',observedAt:new Date().toISOString(),payload:{state},
      ...(seq?{providerCursor:{epoch:'native-cancel-race',seq}}:{}),
      ...(commandId?{commandId}:{}),
    }]});
    await observe('native-cancel-race-running','running','1');
    const cancel=await collab('POST',`/sessions/${sessionId}/commands`,{actor:manager,headers:{'idempotency-key':'native-cancel-race-request'},body:{kind:'cancel'}});
    expect(cancel.status).toBe(202);
    await observe('native-cancel-race-terminal','cancelled','2');
    const late=await observe('native-cancel-race-late-intent','cancel_requested');
    expect(late.body.data.acceptedEventIds).toContain('native-cancel-race-late-intent');
    const cancelled=await collab('GET',`/runs/${run.id}`,{actor:manager});
    expect(cancelled.body.data.run.state).toBe('cancelled');
    expect(cancelled.body.data.sessions.find(session=>session.id===sessionId).state).toBe('cancelled');
    const {getPool}=await import('@fluent-flow/db');
    expect((await getPool().query("SELECT event_id FROM collab_connector_observations WHERE event_id='native-cancel-race-late-intent'")).rows).toHaveLength(1);
    await observe('native-cancel-race-late-running','running','3');
    const stillCancelled=await collab('GET',`/runs/${run.id}`,{actor:manager});
    expect(stillCancelled.body.data.sessions.find(session=>session.id===sessionId).state).toBe('cancelled');
    const prompt=await collab('POST',`/sessions/${sessionId}/commands`,{actor:manager,headers:{'idempotency-key':'native-cancel-race-resume'},body:{kind:'prompt',text:'Continue with the next check',behavior:'steer'}});
    expect(prompt.status).toBe(202);
    const reserved=await collab('GET',`/runs/${run.id}`,{actor:manager});
    expect(reserved.body.data.run.state).toBe('queued');
    expect(reserved.body.data.sessions.find(session=>session.id===sessionId).state).toBe('queued');
    await observe('native-cancel-race-old-intent-after-resume','cancel_requested',undefined,cancel.body.data.commandId);
    const stillReserved=await collab('GET',`/runs/${run.id}`,{actor:manager});
    expect(stillReserved.body.data.run.state).toBe('queued');
    expect(stillReserved.body.data.sessions.find(session=>session.id===sessionId).state).toBe('queued');
    await observe('native-cancel-race-new-turn','running','4');
    const resumed=await collab('GET',`/runs/${run.id}`,{actor:manager});
    expect(resumed.body.data.run.state).toBe('running');
    expect(resumed.body.data.sessions.find(session=>session.id===sessionId).state).toBe('running');
    await observe('native-cancel-race-terminal-again','cancelled','5');
    const liveTask=await collab('GET',`/tasks/${created.body.data.id}`,{actor:manager});
    const retry=await collab('POST',`/tasks/${created.body.data.id}/runs`,{actor:manager,headers:{'idempotency-key':'native-cancel-race-retry'},body:{expectedVersion:liveTask.body.data.version,retryOfRunId:run.id}});
    expect(retry.status).toBe(202);
    for(const state of ['queued','reconciling']) {
      if(state==='reconciling') await connectorCall('POST','/observations',{...connector,events:[{eventId:'native-cancel-race-retry-uncertain',runId:retry.body.data.run.id,sessionId:retry.body.data.sessionId,kind:'state',observedAt:new Date().toISOString(),payload:{state:'reconciling'}}]});
      const blocked=await collab('POST',`/sessions/${sessionId}/commands`,{actor:manager,headers:{'idempotency-key':`native-cancel-race-blocked-${state}`},body:{kind:'prompt',text:'This would duplicate the other attempt',behavior:'steer'}});
      expect(blocked.status).toBe(409);
      const unchanged=await collab('GET',`/runs/${run.id}`,{actor:manager});
      expect(unchanged.body.data.run.state).toBe('cancelled');
      expect(unchanged.body.data.sessions.find(session=>session.id===sessionId).state).toBe('cancelled');
    }
  });
});
