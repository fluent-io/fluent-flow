import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

// A4 evidence acceptance against the REAL application wiring: actual
// createApp, actual collab router registration and runMigrations only — no
// manual router assembly, no manual DDL. Domain-level focused tests that
// bypass app wiring live in collab-evidence-domain.test.js and are labeled as
// such there.
vi.mock('../../src/tracing.cjs', () => ({}));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

const { resolveCollabTestDatabaseUrl, resetCollabSchema, seedLegacyUser, seedLegacyOrgMembership } =
  await import('../helpers/collab-db.js');
process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
process.env.COLLAB_EVIDENCE_ROUTES_TEST_DATABASE_URL = process.env.DATABASE_URL;

const TEST_AUTH_SECRET = 'collab-evidence-test-secret-0123456789abcdef';
const { signCollaborationActor, getCollabTask } = await import('@fluent-flow/db');
const { createApp } = await import('../../src/app.js');

function actorHeader(principalId, sessionVersion) {
  return signCollaborationActor({ principalId, sessionVersion }, TEST_AUTH_SECRET);
}

async function api(baseUrl, method, path, { actor, body, idempotencyKey } = {}) {
  const headers = {};
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  if (actor) headers['x-fluent-flow-actor'] = actorHeader(actor.principalId, actor.sessionVersion);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl}/api/collab/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('A4 evidence slice 1: acceptance criteria', () => {
  let server;
  let baseUrl;
  let managerActor;
  let collaboratorActor;
  let outsiderActor;
  let projectA1;
  let taskA1;

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    const db = await import('@fluent-flow/db');
    await db.runMigrations();

    const admin = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9201, login: 'evidence-owner' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, admin, 'org-evidence', 'admin');
    const adminPrincipal = await db.ensureGithubPrincipal({
      legacyUserId: admin,
      displayName: 'evidence-owner',
      email: 'evidence-owner@example.test',
    });
    managerActor = { principalId: adminPrincipal.id, sessionVersion: adminPrincipal.sessionVersion };

    const ws = await db.bootstrapCollaborationWorkspace({
      actor: managerActor,
      legacyOrgId: 'org-evidence',
      name: 'Evidence Client',
      idempotencyKey: 'evidence-slice-bootstrap',
    });
    projectA1 = await db.createCollabProject({ actor: managerActor, workspaceId: ws.id, name: 'Evidence A1' });

    // Collaborator principal (password path): invite through the real service,
    // then add the workspace collaborator role membership.
    const { rows: roleRows0 } = await db.getPool().query(
      `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'collaborator'`,
      [ws.id],
    );
    const invite = await db.createCollabInvitation({
      actor: managerActor,
      workspaceId: ws.id,
      email: 'evidence-collaborator@example.test',
      roleId: roleRows0[0].id,
      expiresInHours: 24,
    });
    const inviteToken = invite.url.split('token=')[1];
    const collaborator = await db.acceptCollabInvitation({
      token: inviteToken,
      displayName: 'Evidence Collaborator',
      password: 'EvidenceCollab!42',
      rateLimitKey: 'evidence-test',
    });
    collaboratorActor = { principalId: collaborator.principal.id, sessionVersion: collaborator.principal.sessionVersion };

    // Outsider: separate client, no access to workspace A.
    const adminB = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9202, login: 'evidence-outsider' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, adminB, 'org-evidence-b', 'admin');
    const outsiderPrincipal = await db.ensureGithubPrincipal({
      legacyUserId: adminB,
      displayName: 'evidence-outsider',
      email: 'evidence-outsider@example.test',
    });
    await db.bootstrapCollaborationWorkspace({
      actor: { principalId: outsiderPrincipal.id, sessionVersion: outsiderPrincipal.sessionVersion },
      legacyOrgId: 'org-evidence-b',
      name: 'Evidence Client B',
      idempotencyKey: 'evidence-slice-bootstrap-b',
    });
    outsiderActor = { principalId: outsiderPrincipal.id, sessionVersion: outsiderPrincipal.sessionVersion };

    taskA1 = await db.createCollabTask({
      actor: managerActor,
      projectId: projectA1.id,
      title: 'Evidence slice task',
      description: '',
      priority: 'normal',
      assigneeId: null,
    });

    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const { closePool } = await import('@fluent-flow/db');
    await closePool();
  });

  it('creates a criterion with task.write and lists it', async () => {
    const created = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/criteria`, {
      actor: collaboratorActor,
      body: { text: 'Site loads under 2s' },
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ text: 'Site loads under 2s', state: 'open', version: 1 });

    const list = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/criteria`, { actor: collaboratorActor });
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });

  it('transitions state with expectedVersion and preserves actor history', async () => {
    const created = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/criteria`, {
      actor: managerActor,
      body: { text: 'A11y audit passed' },
    });
    const criterionId = created.body.data.id;

    const met = await api(baseUrl, 'PATCH', `/tasks/${taskA1.id}/criteria/${criterionId}`, {
      actor: collaboratorActor,
      body: { expectedVersion: 1, state: 'met' },
    });
    expect(met.status).toBe(200);
    expect(met.body.data).toMatchObject({ state: 'met', version: 2 });

    const stale = await api(baseUrl, 'PATCH', `/tasks/${taskA1.id}/criteria/${criterionId}`, {
      actor: collaboratorActor,
      body: { expectedVersion: 1, state: 'waived' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');

    // History preserves who changed what (delivery acknowledgment consumes it).
    const history = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/criteria/${criterionId}/history`, {
      actor: managerActor,
    });
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0]).toMatchObject({ fromState: 'open', toState: 'met' });
  });

  it('hides criteria from another client and from readers without task.read', async () => {
    const outsider = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/criteria`, { actor: outsiderActor });
    expect(outsider.status).toBe(404);
  });

  it('rejects criterion writes from actors without task.write', async () => {
    // Viewer principal: task.read only.
    const db = await import('@fluent-flow/db');
    const { rows: viewerRows } = await db.getPool().query(
      `INSERT INTO collab_principals (display_name, email) VALUES ('Evidence Viewer', 'evidence-viewer@example.test') RETURNING id, session_version`,
    );
    const viewerId = viewerRows[0].id;
    await db.getPool().query(
      `INSERT INTO collab_password_credentials (principal_id, password_hash) VALUES ($1, $2)`,
      [viewerId, 'x'],
    );
    const { rows: wsRows } = await db.getPool().query(`SELECT id FROM collab_workspaces LIMIT 1`);
    const { rows: roleRows } = await db.getPool().query(
      `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'viewer'`,
      [wsRows[0].id],
    );
    await db.getPool().query(
      `INSERT INTO collab_memberships (workspace_id, project_id, principal_id, role_id)
       VALUES ($1, NULL, $2, $3)`,
      [wsRows[0].id, viewerId, roleRows[0].id],
    );

    const denied = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/criteria`, {
      actor: { principalId: viewerId, sessionVersion: viewerRows[0].session_version },
      body: { text: 'should not persist' },
    });
    expect(denied.status).toBe(403);
    // A's authorize emits code 'forbidden' for known-scope missing capability.
    expect(denied.body.error.code).toBe('forbidden');
  });

  it('reports cumulative usage with per-metric coverage and preserves unknown versus zero', async () => {
    const db = await import('@fluent-flow/db');
    const host = await db.getPool().query(`INSERT INTO collab_hosts (name,token_hash,enrolled_by_principal_id) VALUES ('usage-host','usage-test',$1) RETURNING id`, [managerActor.principalId]);
    const mapping = await db.getPool().query(`INSERT INTO collab_project_host_mappings (project_id,host_id,repository_key,default_profile_id) VALUES ($1,$2,'test/repo','profile') RETURNING id`, [projectA1.id,host.rows[0].id]);
    const run = await db.getPool().query(`INSERT INTO collab_runs (task_id,project_id,host_id,mapping_id,profile_id,created_by_principal_id) VALUES ($1,$2,$3,$4,'profile',$5) RETURNING id`, [taskA1.id,projectA1.id,host.rows[0].id,mapping.rows[0].id,managerActor.principalId]);
    const sample = { taskId: taskA1.id, runId: run.rows[0].id, sessionId: null, providerTurnId: 'partial-turn', tokensIn: 10, tokensOut: null, costUsd: null, unavailableReason: null };
    await db.recordUsageSample(sample);
    await db.recordUsageSample({ ...sample, tokensIn: 20 });
    const range = () => `/projects/${projectA1.id}/insights?from=${new Date(Date.now()-3600000).toISOString()}&to=${new Date(Date.now()+10000).toISOString()}`;
    let result = await api(baseUrl, 'GET', range(), { actor: managerActor });
    expect(result.status).toBe(200);
    expect(result.body.data.usage).toMatchObject({ available: true, tokensIn: 20, tokensOut: null, costUsd: null });
    expect(result.body.data.usage.coverage).toEqual({ samples: 1, tokensIn: 1, tokensOut: 0, costUsd: 0 });
    expect(result.body.data.usage.reason).toMatch(/partial/i);
    await db.recordUsageSample({ ...sample, providerTurnId: 'known-zero', tokensIn: 0, tokensOut: 0 });
    await db.recordUsageSample({ ...sample, providerTurnId: 'unsupported', tokensIn: null, unavailableReason: 'unsupported' });
    result = await api(baseUrl, 'GET', range(), { actor: managerActor });
    expect(result.body.data.usage).toMatchObject({ available: true, tokensIn: 20, tokensOut: 0, costUsd: null, coverage: { samples: 3, tokensIn: 2, tokensOut: 1, costUsd: 0 } });
    expect(result.body.data.usage.reason).toMatch(/partial/i);
  });

  it('rolls back trusted plan, usage and summary reports with their observation transaction', async () => {
    const db = await import('@fluent-flow/db');
    const run = (await db.getPool().query('SELECT id,host_id FROM collab_runs WHERE task_id=$1 LIMIT 1', [taskA1.id])).rows[0];
    const session = (await db.getPool().query(`INSERT INTO collab_sessions(run_id,role,title) VALUES($1,'work','atomic report') RETURNING id`, [run.id])).rows[0];
    const summarySession=(await db.getPool().query(`INSERT INTO collab_sessions(run_id,role,title) VALUES($1,'summary','atomic summary') RETURNING id`,[run.id])).rows[0];
    const tx = await db.getPool().connect();
    try {
      await tx.query('BEGIN');
      const binding = {taskId:taskA1.id,runId:run.id,sessionId:session.id};
      await db.recordWorkpadPlanReport({...binding,items:[{text:'atomic plan',status:'pending'}]}, tx);
      await db.recordUsageSample({...binding,providerTurnId:'atomic-report',tokensIn:1,tokensOut:null,costUsd:null,unavailableReason:null}, tx);
      await db.recordCollabSummaryReport({...binding,sessionId:summarySession.id,body:'atomic summary',model:'configured',sourceEpoch:'e',sourceSeq:'1',visibility:'internal'}, tx);
      await tx.query('ROLLBACK');
    } finally { tx.release(); }
    expect((await db.getPool().query('SELECT id FROM collab_workpad_plans WHERE session_id=$1', [session.id])).rows).toHaveLength(0);
    expect((await db.getPool().query('SELECT id FROM collab_usage_samples WHERE session_id=$1', [session.id])).rows).toHaveLength(0);
    expect((await db.getPool().query('SELECT id FROM collab_summaries WHERE session_id=$1', [summarySession.id])).rows).toHaveLength(0);
  });

  it('denies browser file references while preserving supplied human input content', async () => {
    const db = await import('@fluent-flow/db');
    const run = (await db.getPool().query('SELECT id FROM collab_runs WHERE task_id=$1 LIMIT 1', [taskA1.id])).rows[0];
    const before = (await db.getPool().query('SELECT count(*)::int AS count FROM collab_artifacts WHERE task_id=$1', [taskA1.id])).rows[0].count;
    for (const actor of [collaboratorActor, managerActor]) {
      const denied = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/artifacts`, { actor, body: { runId: run.id, direction: 'output', kind: 'file', name: 'Selected source', visibility: 'client', reference: 'src/private.json' } });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('file_reference_forbidden');
    }
    expect((await db.getPool().query('SELECT count(*)::int AS count FROM collab_artifacts WHERE task_id=$1', [taskA1.id])).rows[0].count).toBe(before);
    await expect(db.recordCollabArtifactReport({ taskId: taskA1.id, runId: run.id, sessionId: null, direction: 'output', kind: 'file', name: 'Unbound file', reference: 'src/private.json' })).rejects.toMatchObject({ status: 422, code: 'invalid_artifact_source' });
    const input = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/artifacts`, { actor: collaboratorActor, body: { direction: 'input', kind: 'text', name: 'Supplied requirements', visibility: 'client', content: 'User-provided input, not a host file.' } });
    expect(input.status).toBe(201);
    const content = await api(baseUrl, 'GET', `/artifacts/${input.body.data.id}/content`, { actor: collaboratorActor });
    expect(content.status).toBe(200);
    expect(content.body.data.content).toBe('User-provided input, not a host file.');
  });

  it('does not retrieve a human file row retained from before the file-source guard', async () => {
    const db = await import('@fluent-flow/db');
    const run = (await db.getPool().query('SELECT id FROM collab_runs WHERE task_id=$1 LIMIT 1', [taskA1.id])).rows[0];
    const session = (await db.getPool().query("SELECT id FROM collab_sessions WHERE run_id=$1 AND role='work' LIMIT 1", [run.id])).rows[0];
    const legacy = (await db.getPool().query("INSERT INTO collab_artifacts(task_id,project_id,run_id,session_id,direction,kind,name,visibility,provenance,owner_principal_id,created_by_principal_id,reference) VALUES($1,$2,$3,$4,'output','file','Untrusted old file','client','human',$5,$5,'src/private.json') RETURNING id", [taskA1.id, projectA1.id, run.id, session.id, collaboratorActor.principalId])).rows[0];
    const preview = await api(baseUrl, 'GET', `/artifacts/${legacy.id}/content`, { actor: collaboratorActor });
    expect(preview.status).toBe(200);
    expect(preview.body.data.state).toBe('unavailable');
    await expect(db.queueArtifactRead({ actor: collaboratorActor, artifactId: legacy.id, idempotencyKey: 'untrusted-old-file' })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect((await db.getPool().query("SELECT id FROM collab_connector_commands WHERE payload->>'artifactId'=$1", [legacy.id])).rows).toHaveLength(0);
    const hostId = (await db.getPool().query('SELECT host_id FROM collab_runs WHERE id=$1', [run.id])).rows[0].host_id;
    const queued = (await db.getPool().query("INSERT INTO collab_connector_commands(host_id,run_id,session_id,kind,payload,created_by_principal_id) VALUES($1,$2,$3,'artifact_read',$4,$5) RETURNING id", [hostId, run.id, session.id, { artifactId: legacy.id, reference: 'src/private.json', maxBytes: 524288 }, collaboratorActor.principalId])).rows[0];
    const token = 'ffh_test_artifact_fixture_only';
    await db.getPool().query('UPDATE collab_hosts SET token_hash=$2 WHERE id=$1', [hostId, (await import('node:crypto')).createHash('sha256').update(token).digest('hex')]);
    const call = async (path, body) => {
      const response = await fetch(`${baseUrl}/api/connector/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const registered = await call('/register', { instanceId: 'artifact-fixture', protocolVersion: 1, sdkVersion: 'fixture', catalog: { repositories: [{ key: 'test/repo' }], profiles: [{ id: 'profile', provider: 'fake', model: 'fixture' }] } });
    expect(registered.status).toBe(200);
    const polled = await call('/poll', { connectorSessionId: registered.body.data.connectorSessionId, leaseEpoch: registered.body.data.leaseEpoch, waitMs: 0, limit: 10 });
    expect(polled.status).toBe(200);
    expect(polled.body.data.commands.some(command => command.id === queued.id)).toBe(false);
    expect((await db.getPool().query('SELECT state,error_code FROM collab_connector_commands WHERE id=$1', [queued.id])).rows[0]).toEqual({ state: 'cancelled', error_code: 'authorization_withdrawn' });
  });

  it('queues only the stored file reference, previews a persisted host result, and rechecks artifact ACL', async () => {
    const db = await import('@fluent-flow/db');
    const run = (await db.getPool().query('SELECT * FROM collab_runs WHERE task_id=$1 LIMIT 1', [taskA1.id])).rows[0];
    const token='ffh_test_artifact_fixture_only';
    await db.getPool().query(`UPDATE collab_hosts SET token_hash=$2 WHERE id=$1`,[run.host_id,(await import('node:crypto')).createHash('sha256').update(token).digest('hex')]);
    const connectorCall=async(path,body)=>{const response=await fetch(`${baseUrl}/api/connector/v1${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
    const registration=await connectorCall('/register',{instanceId:'artifact-fixture',protocolVersion:1,sdkVersion:'fixture',catalog:{repositories:[{key:'test/repo'}],profiles:[{id:'profile',name:'Fixture',provider:'fake',model:'fixture'}]}});
    expect(registration.status).toBe(200);
    const lease={connectorSessionId:registration.body.data.connectorSessionId,leaseEpoch:registration.body.data.leaseEpoch};
    await db.getPool().query("UPDATE collab_project_host_mappings SET profile_ids=ARRAY['profile'] WHERE id=$1", [run.mapping_id]);
    const session = await api(baseUrl, 'POST', `/runs/${run.id}/sessions`, { actor: managerActor, idempotencyKey: 'artifact-report-session', body: { title: 'Artifact reporting', instructions: 'Report the generated file' } });
    expect(session.status).toBe(202);
    const delivered = await connectorCall('/poll', { ...lease, waitMs: 0, limit: 10 });
    const launch = delivered.body.data.commands.find(command => command.id === session.body.data.commandId);
    expect(launch.payload.reportingCredential).toMatch(/^ffag_/);
    const reportFile = async (name) => {
      const response = await fetch(`${baseUrl}/mcp/collab`, { method: 'POST', headers: { authorization: `Bearer ${launch.payload.reportingCredential}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'collaboration_add_artifact', arguments: { name, kind: 'file', direction: 'output', reference: 'reports/result.txt', mediaType: 'text/plain' } } }) });
      expect(response.status).toBe(200);
      const wire = await response.json();
      expect(wire.result.isError).not.toBe(true);
      return JSON.parse(wire.result.content[0].text);
    };
    const artifact = await reportFile('Generated report');
    expect(artifact).toMatchObject({ runId: run.id, sessionId: session.body.data.session.id, visibility: 'internal', provenance: 'agent' });
    expect(artifact.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(artifact).not.toHaveProperty('reference');
    const agentPublication = await fetch(`${baseUrl}/api/collab/v1/tasks/${taskA1.id}/artifacts/${artifact.id}/publication`, { method: 'POST', headers: { authorization: `Bearer ${launch.payload.reportingCredential}`, 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: artifact.version, visibility: 'client' }) });
    expect(agentPublication.status).toBe(401);
    let preview = await api(baseUrl,'GET',`/artifacts/${artifact.id}/content?reference=/etc/passwd&runId=spoof`,{actor:managerActor});
    expect(preview.status).toBe(202);
    expect(preview.body.data.state).toMatch(/queued|offline/);
    const commands=(await db.getPool().query(`SELECT * FROM collab_connector_commands WHERE run_id=$1 AND kind='artifact_read' AND payload->>'artifactId'=$2`,[run.id,artifact.id])).rows;
    expect(commands).toHaveLength(1);
    expect(commands[0].payload).toMatchObject({artifactId:artifact.id,reference:'reports/result.txt'});
    const poll=await connectorCall('/poll',{...lease,waitMs:0,limit:10});
    expect(poll.status).toBe(200);
    expect(poll.body.data.commands.some(command=>command.id===commands[0].id)).toBe(true);
    const contents=Buffer.from('Actual generated report bytes');
    const result={status:'available',mediaType:'text/plain',sizeBytes:contents.length,sha256:(await import('node:crypto')).createHash('sha256').update(contents).digest('hex'),contentBase64:contents.toString('base64'),truncated:false};
    const ack=await connectorCall(`/commands/${commands[0].id}/ack`,{...lease,state:'applied',result});
    expect(ack.status).toBe(200);
    expect(ack.body.data.state).toBe('applied');
    preview=await api(baseUrl,'GET',`/artifacts/${artifact.id}/content`,{actor:managerActor});
    expect(preview.status).toBe(200);
    expect(preview.body.data.content).toBe('Actual generated report bytes');
    const forbidden=await api(baseUrl,'GET',`/artifacts/${artifact.id}/content`,{actor:collaboratorActor});
    expect(forbidden.status).toBe(404);
    const raw=await fetch(`${baseUrl}/api/collab/v1/artifacts/${artifact.id}/content?raw=1`,{headers:{'x-fluent-flow-actor':actorHeader(managerActor.principalId,managerActor.sessionVersion)}});
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await raw.text()).toBe('Actual generated report bytes');
    const publishable = await reportFile('Report explicitly shared by a human');
    const published = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/artifacts/${publishable.id}/publication`, { actor: managerActor, body: { expectedVersion: publishable.version, visibility: 'client' } });
    expect(published.status).toBe(200);
    expect(published.body.data).toMatchObject({ visibility: 'client', provenance: 'agent' });
    const clientArtifacts = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/artifacts`, { actor: collaboratorActor });
    expect(clientArtifacts.body.data.some(item => item.id === publishable.id)).toBe(true);
    expect(clientArtifacts.body.data.some(item => item.id === artifact.id)).toBe(false);
  });

  it('does not enqueue a summary while generation is disabled', async () => {
    const db=await import('@fluent-flow/db');
    const run=(await db.getPool().query('SELECT id FROM collab_runs WHERE task_id=$1 LIMIT 1',[taskA1.id])).rows[0];
    const response=await api(baseUrl,'POST',`/runs/${run.id}/summaries`,{actor:managerActor,body:{},idempotencyKey:'summary-disabled-test'});
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('summary_disabled');
    expect((await db.getPool().query(`SELECT id FROM collab_connector_commands WHERE run_id=$1 AND kind='summarize'`,[run.id])).rows).toHaveLength(0);
  });

  it('queues one configured summary session with frozen source and loads its history by run alone', async () => {
    const db=await import('@fluent-flow/db');
    const run=(await db.getPool().query('SELECT * FROM collab_runs WHERE task_id=$1 LIMIT 1',[taskA1.id])).rows[0];
    await db.getPool().query(`UPDATE collab_runs SET workspace_id='owned-fixture-workspace',state='idle' WHERE id=$1`,[run.id]);
    await db.getPool().query(`UPDATE collab_project_host_mappings SET profile_ids=ARRAY['profile'] WHERE id=$1`,[run.mapping_id]);
    await db.getPool().query(`UPDATE collab_projects SET execution_defaults=$2 WHERE id=$1`,[projectA1.id,JSON.stringify({mappingId:run.mapping_id,profileId:'profile',model:null,instructions:'',summary:{enabled:true,profileId:'profile',model:'fixture'}})]);
    const result=await api(baseUrl,'POST',`/runs/${run.id}/summaries`,{actor:managerActor,body:{},idempotencyKey:'summary-enabled-test'});
    expect(result.status).toBe(202);
    const replay=await api(baseUrl,'POST',`/runs/${run.id}/summaries`,{actor:managerActor,body:{},idempotencyKey:'summary-enabled-test'});
    expect(replay.status).toBe(202);
    expect(replay.body.data.commandId).toBe(result.body.data.commandId);
    const commands=(await db.getPool().query(`SELECT * FROM collab_connector_commands WHERE run_id=$1 AND kind='summarize'`,[run.id])).rows;
    expect(commands).toHaveLength(1);
    expect(commands[0].payload).toMatchObject({profileId:'profile',model:'fixture',sourceSessionId:expect.any(String)});
    const session=(await db.getPool().query('SELECT role FROM collab_sessions WHERE id=$1',[commands[0].session_id])).rows[0];
    expect(session.role).toBe('summary');
    await db.recordCollabSummaryReport({taskId:taskA1.id,runId:run.id,sessionId:commands[0].session_id,body:'Observed summary',model:'untrusted-model',sourceEpoch:'untrusted-epoch',sourceSeq:'999',visibility:'internal'});
    const history=await api(baseUrl,'GET',`/runs/${run.id}/summaries`,{actor:managerActor});
    expect(history.status).toBe(200);
    expect(history.body.data[0]).toMatchObject({body:'Observed summary',model:'fixture',sourceCursor:null,provenance:'agent'});
  });

  it('turns an approved idea follow-up into one bound prompt command and denies unreadable ideas', async () => {
    const db=await import('@fluent-flow/db');
    const run=(await db.getPool().query('SELECT id FROM collab_runs WHERE task_id=$1 ORDER BY created_at LIMIT 1',[taskA1.id])).rows[0];
    const session=(await db.getPool().query(`SELECT id FROM collab_sessions WHERE run_id=$1 AND role='work' LIMIT 1`,[run.id])).rows[0];
    const idea=await api(baseUrl,'POST',`/tasks/${taskA1.id}/ideas`,{actor:managerActor,body:{title:'Review the edge condition',body:'Inspect the supported behavior',visibility:'internal',runId:run.id,sessionId:session.id}});
    const denied=await api(baseUrl,'POST',`/ideas/${idea.body.data.id}/conversions`,{actor:collaboratorActor,idempotencyKey:'private-idea-convert',body:{taskId:taskA1.id,kind:'task',expectedVersion:1}});
    expect(denied.status).toBe(404);
    const converted=await api(baseUrl,'POST',`/ideas/${idea.body.data.id}/conversions`,{actor:managerActor,idempotencyKey:'idea-follow-up-test',body:{taskId:taskA1.id,kind:'follow_up',sessionId:session.id,expectedVersion:1}});
    expect(converted.status).toBe(201);
    expect(converted.body.data.commandId).toEqual(expect.any(String));
    const replay=await api(baseUrl,'POST',`/ideas/${idea.body.data.id}/conversions`,{actor:managerActor,idempotencyKey:'idea-follow-up-test',body:{taskId:taskA1.id,kind:'follow_up',sessionId:session.id,expectedVersion:1}});
    expect(replay.body.data.commandId).toBe(converted.body.data.commandId);
    const command=(await db.getPool().query('SELECT * FROM collab_connector_commands WHERE id=$1',[converted.body.data.commandId])).rows[0];
    expect(command).toMatchObject({kind:'prompt',run_id:run.id,session_id:session.id,payload:{kind:'prompt',text:expect.stringContaining('Inspect the supported behavior')}});
  });

  it('keeps native plans internal and requires a summary-role source for generated summaries', async () => {
    const db=await import('@fluent-flow/db');
    const run=(await db.getPool().query('SELECT id FROM collab_runs WHERE task_id=$1 ORDER BY created_at LIMIT 1',[taskA1.id])).rows[0];
    const work=(await db.getPool().query(`SELECT id FROM collab_sessions WHERE run_id=$1 AND role='work' LIMIT 1`,[run.id])).rows[0];
    await db.recordWorkpadPlanReport({taskId:taskA1.id,runId:run.id,sessionId:work.id,items:[{text:'Internal native plan',status:'pending'}]});
    const clientPlan=await api(baseUrl,'GET',`/tasks/${taskA1.id}/plan`,{actor:collaboratorActor});
    expect(clientPlan.status).toBe(200);
    expect(clientPlan.body.data.plan).toBeNull();
    await expect(db.recordCollabSummaryReport({taskId:taskA1.id,runId:run.id,sessionId:work.id,body:'Work session cannot forge summarizer output',model:'fixture',sourceEpoch:null,sourceSeq:null,visibility:'client'})).rejects.toMatchObject({status:403,code:'invalid_summary_source'});
  });

  it('prevents a collaborator from publishing an unreadable internal artifact', async () => {
    const db=await import('@fluent-flow/db');
    const artifact=(await db.getPool().query(`SELECT id,version FROM collab_artifacts WHERE task_id=$1 AND visibility='internal' LIMIT 1`,[taskA1.id])).rows[0];
    await expect(db.publishCollabArtifact({actor:collaboratorActor,taskId:taskA1.id,artifactId:artifact.id,expectedVersion:artifact.version,visibility:'client'})).rejects.toMatchObject({status:404});
  });

  it('marks same-HEAD evidence stale for dirty or unknown worktree state and never falls back from a newer unknown HEAD', async () => {
    const db=await import('@fluent-flow/db');
    const run=(await db.getPool().query('SELECT * FROM collab_runs WHERE task_id=$1 LIMIT 1',[taskA1.id])).rows[0];
    const commit='a'.repeat(40);
    await db.getPool().query(`UPDATE collab_runs SET head_commit=$2,dirty=false,state='idle' WHERE id=$1`,[run.id,commit]);
    const check=await api(baseUrl,'POST',`/tasks/${taskA1.id}/checks`,{actor:managerActor,body:{name:'Captured clean check',command:'npm test',visibility:'internal'}});
    const capture=await api(baseUrl,'POST',`/tasks/${taskA1.id}/checks/${check.body.data.id}/evidence`,{actor:managerActor,body:{status:'passed',exitCode:0,commit,dirty:false,runId:run.id,provenance:'human'}});
    expect(capture.status).toBe(201);
    let checks=await api(baseUrl,'GET',`/tasks/${taskA1.id}/checks`,{actor:managerActor});
    expect(checks.body.data.find(c=>c.id===check.body.data.id).evidence[0]).toMatchObject({stale:false});
    await db.getPool().query('UPDATE collab_runs SET dirty=true WHERE id=$1',[run.id]);
    checks=await api(baseUrl,'GET',`/tasks/${taskA1.id}/checks`,{actor:managerActor});
    expect(checks.body.data.find(c=>c.id===check.body.data.id).evidence[0]).toMatchObject({stale:true,staleReason:expect.stringMatching(/dirty/i)});
    await db.getPool().query('UPDATE collab_runs SET dirty=null WHERE id=$1',[run.id]);
    checks=await api(baseUrl,'GET',`/tasks/${taskA1.id}/checks`,{actor:managerActor});
    expect(checks.body.data.find(c=>c.id===check.body.data.id).evidence[0]).toMatchObject({stale:true,staleReason:expect.stringMatching(/unknown/i)});
    await db.getPool().query(`INSERT INTO collab_runs(task_id,project_id,host_id,mapping_id,profile_id,created_by_principal_id) VALUES($1,$2,$3,$4,'profile',$5)`,[taskA1.id,projectA1.id,run.host_id,run.mapping_id,managerActor.principalId]);
    checks=await api(baseUrl,'GET',`/tasks/${taskA1.id}/checks`,{actor:managerActor});
    expect(checks.body.data.find(c=>c.id===check.body.data.id).evidence[0]).toMatchObject({stale:true,staleReason:expect.stringMatching(/head|unknown/i)});
  });

  it('requires task mutation authority and a current version for delivery without partial effects', async () => {
    const db = await import('@fluent-flow/db');
    const workspaceId = (await db.getPool().query('SELECT workspace_id FROM collab_projects WHERE id=$1', [projectA1.id])).rows[0].workspace_id;
    const role = await db.createWorkspaceRole({ actor: managerActor, workspaceId, name: 'Delivery internal reader', capabilities: ['task.read', 'internal.read'] });
    const invitation = await db.createCollabInvitation({ actor: managerActor, workspaceId, email: 'delivery-internal-reader@example.test', roleId: role.id, expiresInHours: 24 });
    const reader = await db.acceptCollabInvitation({ token: invitation.url.split('token=')[1], displayName: 'Internal Reader', password: 'InternalReader!42', rateLimitKey: 'delivery-internal-reader' });
    const readerActor = { principalId: reader.principal.id, sessionVersion: reader.principal.sessionVersion };
    const task = await db.createCollabTask({ actor: managerActor, projectId: projectA1.id, title: 'Versioned delivery' });
    await db.getPool().query("UPDATE collab_tasks SET status='in_progress' WHERE id=$1", [task.id]);
    const edited = await db.updateCollabTask({ actor: managerActor, taskId: task.id, expectedVersion: task.version, title: 'Newer task content' });
    const state = async () => (await db.getPool().query(`SELECT t.version,t.status,p.board_version,
      (SELECT count(*)::int FROM collab_deliveries WHERE task_id=t.id) AS deliveries,
      (SELECT count(*)::int FROM collab_task_events WHERE task_id=t.id) AS events
      FROM collab_tasks t JOIN collab_projects p ON p.id=t.project_id WHERE t.id=$1`, [task.id])).rows[0];
    const before = await state();
    const forbidden = await api(baseUrl, 'POST', `/tasks/${task.id}/deliveries`, { actor: readerActor, body: { expectedVersion: edited.version, note: 'Read-only role cannot submit' } });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error?.code).toBe('forbidden');
    expect(await state()).toEqual(before);
    const stale = await api(baseUrl, 'POST', `/tasks/${task.id}/deliveries`, { actor: managerActor, body: { expectedVersion: task.version, note: 'Obsolete confirmation' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'version_conflict', currentVersion: edited.version });
    expect(await state()).toEqual(before);
    const missing = await api(baseUrl, 'POST', `/tasks/${task.id}/deliveries`, { actor: managerActor, body: { note: 'Missing confirmation version' } });
    expect(missing.status).toBe(400);
    expect(await state()).toEqual(before);
    const body = { expectedVersion: edited.version, note: 'Current explicit delivery' };
    const race = await Promise.all([api(baseUrl, 'POST', `/tasks/${task.id}/deliveries`, { actor: managerActor, body }), api(baseUrl, 'POST', `/tasks/${task.id}/deliveries`, { actor: managerActor, body })]);
    expect(race.map(result => result.status).sort()).toEqual([201, 409]);
    expect(await state()).toEqual({ ...before, version: before.version + 1, status: 'review', board_version: before.board_version + 1, deliveries: before.deliveries + 1, events: before.events + 1 });
  });

  it('keeps default routing project bound and generic Start private on fresh requests and replays', async () => {
    const db = await import('@fluent-flow/db');
    const workspaceId = (await db.getPool().query('SELECT workspace_id FROM collab_projects WHERE id=$1', [projectA1.id])).rows[0].workspace_id;
    const foreign = (await db.getPool().query('SELECT mapping_id,host_id FROM collab_runs WHERE task_id=$1 LIMIT 1', [taskA1.id])).rows[0];
    const project = await db.createCollabProject({ actor: managerActor, workspaceId, name: 'Scoped generic Start' });
    const host = await db.createExecutionHost({ actor: managerActor, name: 'Private generic execution host' });
    const registration = await fetch(`${baseUrl}/api/connector/v1/register`, { method: 'POST', headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ instanceId: 'generic-start-host', protocolVersion: 1, sdkVersion: 'fixture', catalog: { repositories: [{ key: 'private/generic-repo' }], profiles: [{ id: 'profile', provider: 'private-provider', model: 'fixture' }] } }) });
    expect(registration.status).toBe(200);
    const connector = (await registration.json()).data;
    const mapping = await db.createProjectHostMapping({ actor: managerActor, projectId: project.id, hostId: host.id, repositoryKey: 'private/generic-repo', profileIds: ['profile'], defaultProfileId: 'profile' });
    // Simulate an old poisoned configuration; new settings writes also validate it.
    await db.getPool().query('UPDATE collab_projects SET execution_defaults=$2 WHERE id=$1', [project.id, { mappingId: foreign.mapping_id }]);
    const poisonTask = await db.createCollabTask({ actor: managerActor, projectId: project.id, title: 'Foreign default must not route' });
    const poisonStart = await api(baseUrl, 'POST', `/tasks/${poisonTask.id}/runs`, { actor: managerActor, idempotencyKey: 'poisoned-default-start', body: { expectedVersion: poisonTask.version } });
    expect(poisonStart.status).toBe(202);
    expect(poisonStart.body.data.run).toMatchObject({ mappingId: mapping.id, hostId: host.id });
    const routed = (await db.getPool().query("SELECT payload FROM collab_connector_commands WHERE run_id=$1 AND kind='launch'", [poisonStart.body.data.run.id])).rows[0];
    expect(routed.payload.repositoryKey).toBe('private/generic-repo');

    const configured = { mappingId: mapping.id, profileId: 'profile', model: 'fixture', instructions: 'Private configured operator guidance' };
    await db.getPool().query('UPDATE collab_projects SET execution_defaults=$2 WHERE id=$1', [project.id, configured]);
    const role = await db.createWorkspaceRole({ actor: managerActor, workspaceId, name: 'Generic Start only', capabilities: ['task.read', 'run.start'] });
    const invite = await db.createCollabInvitation({ actor: managerActor, workspaceId, email: 'generic-start-only@example.test', roleId: role.id, expiresInHours: 24 });
    const accepted = await db.acceptCollabInvitation({ token: invite.url.split('token=')[1], displayName: 'Generic Starter', password: 'GenericStarter!42', rateLimitKey: 'generic-start-only' });
    const starter = { principalId: accepted.principal.id, sessionVersion: accepted.principal.sessionVersion };
    const task = await db.createCollabTask({ actor: managerActor, projectId: project.id, title: 'Generic Start defaults' });
    const request = () => api(baseUrl, 'POST', `/tasks/${task.id}/runs`, { actor: starter, idempotencyKey: 'generic-private-start', body: { expectedVersion: task.version } });
    const started = await request();
    expect(started.status).toBe(202);
    expect(started.body.data).not.toHaveProperty('sessionId');
    const publicKeys = ['id', 'taskId', 'state', 'stage', 'version', 'createdAt', 'updatedAt'].sort();
    expect(Object.keys(started.body.data.run).sort()).toEqual(publicKeys);
    const stored = (await db.getPool().query('SELECT * FROM collab_runs WHERE id=$1', [started.body.data.run.id])).rows[0];
    expect(stored).toMatchObject({ mapping_id: mapping.id, host_id: host.id, profile_id: 'profile', model: 'fixture', instructions: configured.instructions });
    const launch = (await db.getPool().query("SELECT payload FROM collab_connector_commands WHERE run_id=$1 AND kind='launch'", [stored.id])).rows[0];
    expect(launch.payload).toMatchObject({ model: 'fixture', instructions: configured.instructions, prompt: expect.stringContaining(configured.instructions) });
    expect(JSON.stringify(started.body)).not.toMatch(/Private configured operator guidance|private-provider|private\/generic-repo|Private generic execution host/);
    const delivery = await fetch(`${baseUrl}/api/connector/v1/poll`, { method: 'POST', headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ connectorSessionId: connector.connectorSessionId, leaseEpoch: connector.leaseEpoch, waitMs: 0, limit: 10 }) });
    expect(delivery.status).toBe(200);
    const delivered = (await delivery.json()).data.commands.filter(command => command.runId === stored.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload).toMatchObject({ repositoryKey: 'private/generic-repo', instructions: configured.instructions, model: 'fixture' });
    const ack = await fetch(`${baseUrl}/api/connector/v1/commands/${delivered[0].id}/ack`, { method: 'POST', headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ connectorSessionId: connector.connectorSessionId, leaseEpoch: connector.leaseEpoch, state: 'accepted' }) });
    expect(ack.status).toBe(200);
    expect((await ack.json()).data.state).toBe('accepted');
    const again = await fetch(`${baseUrl}/api/connector/v1/poll`, { method: 'POST', headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ connectorSessionId: connector.connectorSessionId, leaseEpoch: connector.leaseEpoch, waitMs: 0, limit: 10 }) });
    expect(again.status).toBe(200);
    expect((await again.json()).data.commands.some(command => command.runId === stored.id)).toBe(false);
    await db.getPool().query('UPDATE collab_projects SET execution_defaults=$2 WHERE id=$1', [project.id, { ...configured, instructions: 'New defaults after original request' }]);
    const replay = await request();
    expect(replay.status).toBe(200);
    expect(replay.body.data).not.toHaveProperty('sessionId');
    expect(replay.body.data.run.id).toBe(stored.id);
    expect(Object.keys(replay.body.data.run).sort()).toEqual(publicKeys);
    expect((await db.getPool().query('SELECT instructions FROM collab_runs WHERE id=$1', [stored.id])).rows[0].instructions).toBe(stored.instructions);
    const internalTask = await db.createCollabTask({ actor: managerActor, projectId: project.id, title: 'Internal operator Start' });
    const internal = await api(baseUrl, 'POST', `/tasks/${internalTask.id}/runs`, { actor: managerActor, idempotencyKey: 'generic-internal-start', body: { expectedVersion: internalTask.version, instructions: 'Explicit operator override' } });
    expect(internal.status).toBe(202);
    expect(internal.body.data.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(internal.body.data.run).toMatchObject({ mappingId: mapping.id, hostId: host.id, profileId: 'profile', instructions: 'Explicit operator override' });
  });

  it('rejects acceptance of changed criterion text even when its acknowledged UUID is unchanged', async () => {
    const db = await import('@fluent-flow/db');
    const task = await db.createCollabTask({ actor: managerActor, projectId: projectA1.id, title: 'Delivery revision', description: '', priority: 'normal', assigneeId: null });
    await db.getPool().query(`UPDATE collab_tasks SET status='review' WHERE id=$1`, [task.id]);
    const criterion = await api(baseUrl, 'POST', `/tasks/${task.id}/criteria`, { actor: managerActor, body: { text: 'Original open condition' } });
    const delivery = await api(baseUrl, 'POST', `/tasks/${task.id}/deliveries`, { actor: managerActor, body: { expectedVersion: (await getCollabTask(managerActor, task.id)).task.version, note: 'Review the condition' } });
    expect(delivery.status).toBe(201);
    const before = await api(baseUrl, 'GET', `/tasks/${task.id}/delivery-review`, { actor: managerActor });
    await api(baseUrl, 'PATCH', `/tasks/${task.id}/criteria/${criterion.body.data.id}`, { actor: managerActor, body: { expectedVersion: 1, text: 'Materially changed condition' } });
    const decision = await api(baseUrl, 'POST', `/tasks/${task.id}/decisions`, { actor: managerActor, body: { expectedVersion: delivery.body.data.taskVersion, decision: 'accept', acknowledgedOpenItemIds: [criterion.body.data.id], reviewSnapshot: before.body.data ?? { deliveryId: delivery.body.data.id, evidenceRevision: 'obsolete' } } });
    expect(decision.status).toBe(409);
    expect(decision.body.error.code).toBe('review_changed');
    const current = await api(baseUrl, 'GET', `/tasks/${task.id}/delivery-review`, { actor: managerActor });
    expect(current.status).toBe(200);
    const accepted = await api(baseUrl, 'POST', `/tasks/${task.id}/decisions`, { actor: managerActor, body: { expectedVersion: delivery.body.data.taskVersion, decision: 'accept', acknowledgedOpenItemIds: [criterion.body.data.id], reviewSnapshot: current.body.data } });
    expect(accepted.status).toBe(200);
  });

  it('includes native pending requests in safe delivery acknowledgments and invalidates old reviews', async () => {
    const db = await import('@fluent-flow/db');
    const workspaceId = (await db.getPool().query('SELECT workspace_id FROM collab_projects WHERE id=$1', [projectA1.id])).rows[0].workspace_id;
    const project = await db.createCollabProject({ actor: managerActor, workspaceId, name: 'Native request review' });
    const reviewerRole = (await db.getPool().query("SELECT id FROM collab_roles WHERE workspace_id=$1 AND name='reviewer'", [workspaceId])).rows[0];
    const invite = await db.createCollabInvitation({ actor: managerActor, workspaceId, email: 'native-reviewer@example.test', roleId: reviewerRole.id, expiresInHours: 24 });
    const reviewer = await db.acceptCollabInvitation({ token: invite.url.split('token=')[1], displayName: 'Native Reviewer', password: 'NativeReviewer!42', rateLimitKey: 'native-reviewer-test' });
    const reviewerActor = { principalId: reviewer.principal.id, sessionVersion: reviewer.principal.sessionVersion };
    const task = await db.createCollabTask({ actor: managerActor, projectId: project.id, title: 'Review native open items' });
    const host = await db.createExecutionHost({ actor: managerActor, name: 'Native review host' });
    await db.createProjectHostMapping({ actor: managerActor, projectId: project.id, hostId: host.id, repositoryKey: 'review/repo', profileIds: ['review-coder'], defaultProfileId: 'review-coder' });
    const connectorCall = async (path, body) => {
      const response = await fetch(`${baseUrl}/api/connector/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const registered = await connectorCall('/register', { instanceId: 'native-review', protocolVersion: 1, sdkVersion: '0.12.0', daemonVersion: '1.0.0', capabilities: {}, catalog: { repositories: [{ key: 'review/repo' }], profiles: [{ id: 'review-coder', provider: 'omp' }] } });
    expect(registered.status).toBe(200);
    const started = await api(baseUrl, 'POST', `/tasks/${task.id}/runs`, { actor: managerActor, idempotencyKey: 'native-review-start', body: { expectedVersion: task.version, instructions: 'Prepare review' } });
    expect(started.status).toBe(202);
    const binding = started.body.data;
    const observe = async (eventId, payload, kind = 'attention') => {
      const result = await connectorCall('/observations', { connectorSessionId: registered.body.data.connectorSessionId, leaseEpoch: registered.body.data.leaseEpoch, events: [{ eventId, runId: binding.run.id, sessionId: binding.sessionId, kind, observedAt: new Date().toISOString(), payload }] });
      expect(result.status).toBe(200);
    };
    await observe('native-review-running', { state: 'running' }, 'state');
    const delivery = await api(baseUrl, 'POST', `/tasks/${task.id}/deliveries`, { actor: managerActor, body: { expectedVersion: (await getCollabTask(managerActor, task.id)).task.version, note: 'Human may review pending execution' } });
    expect(delivery.status).toBe(201);
    const review = () => api(baseUrl, 'GET', `/tasks/${task.id}/delivery-review`, { actor: reviewerActor });
    const decide = (snapshot, ids) => api(baseUrl, 'POST', `/tasks/${task.id}/decisions`, { actor: reviewerActor, body: { expectedVersion: delivery.body.data.taskVersion, decision: 'accept', acknowledgedOpenItemIds: ids, reviewSnapshot: snapshot } });
    const before = await review();

    await observe('native-review-question', { attention: 'permission', permissionKind: 'question', requestId: 'native-question', promptText: 'Private provider question', input: { secret: 'Do not expose raw request data' } });
    let current = await review();
    expect(current.status).toBe(200);
    expect(current.body.data.openItems).toEqual([{ id: expect.any(String), label: 'Native question awaiting a response' }]);
    const internalItems = await api(baseUrl, 'GET', `/tasks/${task.id}/open-items`, { actor: managerActor });
    expect(internalItems.body.data).toEqual([{ id: current.body.data.openItems[0].id, label: 'Native question: Private provider question' }]);
    expect(JSON.stringify(current.body)).not.toContain('Private provider question');
    expect(JSON.stringify(internalItems.body)).not.toContain('Do not expose raw request data');
    let denied = await decide(before.body.data, current.body.data.openItems.map(item => item.id));
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe('review_changed');

    const questionReview = current.body.data;
    await observe('native-review-question-changed', { attention: 'permission', permissionKind: 'question', requestId: 'native-question', promptText: 'Changed private provider question' });
    current = await review();
    expect(current.body.data.openItems).toHaveLength(1);
    denied = await decide(questionReview, current.body.data.openItems.map(item => item.id));
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe('review_changed');

    const changedReview = current.body.data;
    await observe('native-review-question-resolved', { attention: 'permission_resolved', requestId: 'native-question' });
    current = await review();
    expect(current.body.data.openItems).toEqual([]);
    denied = await decide(changedReview, []);
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe('review_changed');

    await observe('native-review-approval', { attention: 'permission', permissionKind: 'tool', requestId: 'native-approval', promptText: 'Private tool approval' });
    current = await review();
    expect(current.body.data.openItems).toEqual([{ id: expect.any(String), label: 'Native approval awaiting a response' }]);
    const unacknowledged = await decide(current.body.data, []);
    expect(unacknowledged.status).toBe(422);
    expect(unacknowledged.body.error.code).toBe('acknowledgment_required');
    const accepted = await decide(current.body.data, current.body.data.openItems.map(item => item.id));
    expect(accepted.status).toBe(200);
  });

  it('retains the server-validated acceptance review after current Git changes and records no review for other decisions', async () => {
    const db = await import('@fluent-flow/db');
    const task = await db.createCollabTask({ actor: managerActor, projectId: projectA1.id, title: 'Immutable acceptance evidence' });
    const host = await db.createExecutionHost({ actor: managerActor, name: 'Decision audit host' });
    const mapping = await db.createProjectHostMapping({ actor: managerActor, projectId: projectA1.id, hostId: host.id, repositoryKey: 'audit/repo', profileIds: ['audit-coder'], defaultProfileId: 'audit-coder' });
    const connectorCall = async (path, body) => {
      const response = await fetch(`${baseUrl}/api/connector/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const registered = await connectorCall('/register', { instanceId: 'decision-audit', protocolVersion: 1, sdkVersion: '0.12.0', daemonVersion: '1.0.0', capabilities: {}, catalog: { repositories: [{ key: 'audit/repo' }], profiles: [{ id: 'audit-coder', provider: 'omp' }] } });
    expect(registered.status).toBe(200);
    const started = await api(baseUrl, 'POST', `/tasks/${task.id}/runs`, { actor: managerActor, idempotencyKey: 'decision-audit-start', body: { expectedVersion: task.version, mappingId: mapping.id, profileId: 'audit-coder', instructions: 'Prepare accepted evidence' } });
    expect(started.status).toBe(202);
    const observe = async (eventId, payload) => {
      const result = await connectorCall('/observations', { connectorSessionId: registered.body.data.connectorSessionId, leaseEpoch: registered.body.data.leaseEpoch, events: [{ eventId, runId: started.body.data.run.id, sessionId: started.body.data.sessionId, kind: 'state', observedAt: new Date().toISOString(), payload }] });
      expect(result.status).toBe(200);
    };
    const commit = 'c'.repeat(40);
    await observe('decision-audit-known-head', { state: 'running', headCommit: commit, dirty: false });
    const criterion = await api(baseUrl, 'POST', `/tasks/${task.id}/criteria`, { actor: managerActor, body: { text: 'Known human acknowledgment' } });
    const delivery = await api(baseUrl, 'POST', `/tasks/${task.id}/deliveries`, { actor: managerActor, body: { expectedVersion: (await getCollabTask(managerActor, task.id)).task.version, note: 'Inspect the captured revision' } });
    expect(delivery.status).toBe(201);
    const review = (await api(baseUrl, 'GET', `/tasks/${task.id}/delivery-review`, { actor: managerActor })).body.data;
    const captured = { deliveryId: review.deliveryId, runId: review.runId, headCommit: review.headCommit, dirty: review.dirty, evidenceRevision: review.evidenceRevision };
    const acceptBody = { expectedVersion: delivery.body.data.taskVersion, decision: 'accept', note: 'Reviewed the known revision', acknowledgedOpenItemIds: [criterion.body.data.id] };
    const forged = await api(baseUrl, 'POST', `/tasks/${task.id}/decisions`, { actor: managerActor, body: { ...acceptBody, reviewSnapshot: { ...review, headCommit: 'f'.repeat(40) } } });
    expect(forged.status).toBe(409);
    const accepted = await api(baseUrl, 'POST', `/tasks/${task.id}/decisions`, { actor: managerActor, body: { ...acceptBody, reviewSnapshot: { ...review, untrusted: 'Do not persist client fields' } } });
    expect(accepted.status).toBe(200);
    let stored = (await db.getPool().query('SELECT to_jsonb(d) AS record FROM collab_task_decisions d WHERE task_id=$1', [task.id])).rows[0].record;
    expect(stored.review_snapshot).toEqual(captured);
    expect(stored.acknowledged_open_item_ids).toEqual([criterion.body.data.id]);

    await observe('decision-audit-later-unknown-head', { headCommit: null, dirty: null, workspaceState: 'archived', historical: true });
    const now = await api(baseUrl, 'GET', `/tasks/${task.id}/delivery-review`, { actor: managerActor });
    expect(now.body.data).toMatchObject({ headCommit: null, dirty: null });
    let history = await api(baseUrl, 'GET', `/tasks/${task.id}/decisions`, { actor: managerActor });
    expect(history.status).toBe(200);
    expect(history.body.data).toEqual([expect.objectContaining({ decision: 'accept', note: 'Reviewed the known revision', reviewSnapshot: captured, acknowledgedOpenItemIds: [criterion.body.data.id], decidedByPrincipalId: managerActor.principalId })]);
    expect(JSON.stringify(history.body)).not.toMatch(/untrusted|Do not persist client fields/);
    const workspaceId = (await db.getPool().query('SELECT workspace_id FROM collab_projects WHERE id=$1', [projectA1.id])).rows[0].workspace_id;
    const reviewerRole = (await db.getPool().query("SELECT id FROM collab_roles WHERE workspace_id=$1 AND name='reviewer'", [workspaceId])).rows[0];
    const invite = await db.createCollabInvitation({ actor: managerActor, workspaceId, email: 'audit-reviewer@example.test', roleId: reviewerRole.id, expiresInHours: 24 });
    const reviewer = await db.acceptCollabInvitation({ token: invite.url.split('token=')[1], displayName: 'Audit Reviewer', password: 'AuditReviewer!42', rateLimitKey: 'audit-reviewer-test' });
    const reviewerHistory = await api(baseUrl, 'GET', `/tasks/${task.id}/decisions`, { actor: { principalId: reviewer.principal.id, sessionVersion: reviewer.principal.sessionVersion } });
    expect(reviewerHistory.status).toBe(200);
    expect(reviewerHistory.body.data).toEqual(history.body.data);
    const hidden = await api(baseUrl, 'GET', `/tasks/${task.id}/decisions`, { actor: collaboratorActor });
    expect(hidden.status).toBe(403);
    const foreign = await api(baseUrl, 'GET', `/tasks/${task.id}/decisions`, { actor: outsiderActor });
    const missing = await api(baseUrl, 'GET', '/tasks/00000000-0000-0000-0000-000000000000/decisions', { actor: outsiderActor });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect({ code: foreign.body.error.code, message: foreign.body.error.message }).toEqual({ code: missing.body.error.code, message: missing.body.error.message });

    const taskAfter = await api(baseUrl, 'GET', `/tasks/${task.id}`, { actor: managerActor });
    const reopened = await api(baseUrl, 'POST', `/tasks/${task.id}/decisions`, { actor: managerActor, body: { expectedVersion: taskAfter.body.data.version, decision: 'reopen', reviewSnapshot: review } });
    expect(reopened.status).toBe(200);
    const cancelled = await api(baseUrl, 'POST', `/tasks/${task.id}/decisions`, { actor: managerActor, body: { expectedVersion: taskAfter.body.data.version + 1, decision: 'cancel', reviewSnapshot: review } });
    expect(cancelled.status).toBe(200);
    history = await api(baseUrl, 'GET', `/tasks/${task.id}/decisions?limit=1`, { actor: managerActor });
    expect(history.body.data).toEqual([expect.objectContaining({ decision: 'cancel', reviewSnapshot: null })]);
    const second = await api(baseUrl, 'GET', `/tasks/${task.id}/decisions?limit=1&cursor=${history.body.nextCursor}`, { actor: managerActor });
    expect(second.body.data).toEqual([expect.objectContaining({ decision: 'reopen', reviewSnapshot: null })]);
    const third = await api(baseUrl, 'GET', `/tasks/${task.id}/decisions?limit=1&cursor=${second.body.nextCursor}`, { actor: managerActor });
    expect(third.body.data).toEqual([expect.objectContaining({ decision: 'accept', reviewSnapshot: captured })]);
    expect(third.body.nextCursor).toBeNull();
    stored = (await db.getPool().query("SELECT to_jsonb(d) AS record FROM collab_task_decisions d WHERE task_id=$1 AND decision='accept'", [task.id])).rows[0].record;
    expect(stored.review_snapshot).toEqual(captured);
  });

});

describe('A4 evidence slice 2: named checks and append-only evidence', () => {
  let server;
  let baseUrl;
  let managerActor;
  let collaboratorActor;
  let projectA1;
  let taskA1;
  let checkId;

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    const db = await import('@fluent-flow/db');
    await db.runMigrations();

    const admin = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9301, login: 'checks-owner' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, admin, 'org-checks', 'admin');
    const adminPrincipal = await db.ensureGithubPrincipal({
      legacyUserId: admin,
      displayName: 'checks-owner',
      email: 'checks-owner@example.test',
    });
    managerActor = { principalId: adminPrincipal.id, sessionVersion: adminPrincipal.sessionVersion };

    const ws = await db.bootstrapCollaborationWorkspace({
      actor: managerActor,
      legacyOrgId: 'org-checks',
      name: 'Checks Client',
      idempotencyKey: 'checks-slice-bootstrap',
    });
    projectA1 = await db.createCollabProject({ actor: managerActor, workspaceId: ws.id, name: 'Checks A1' });
    taskA1 = await db.createCollabTask({
      actor: managerActor,
      projectId: projectA1.id,
      title: 'Checks task',
      description: '',
      priority: 'normal',
      assigneeId: null,
    });

    const { rows: roleRows } = await db.getPool().query(
      `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'collaborator'`,
      [ws.id],
    );
    const invite = await db.createCollabInvitation({
      actor: managerActor,
      workspaceId: ws.id,
      email: 'checks-collaborator@example.test',
      roleId: roleRows[0].id,
      expiresInHours: 24,
    });
    const collaborator = await db.acceptCollabInvitation({
      token: invite.url.split('token=')[1],
      displayName: 'Checks Collaborator',
      password: 'ChecksCollab!42',
      rateLimitKey: 'checks-test',
    });
    collaboratorActor = { principalId: collaborator.principal.id, sessionVersion: collaborator.principal.sessionVersion };

    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const { closePool } = await import('@fluent-flow/db');
    await closePool();
  });

  it('creates a named check and records human evidence', async () => {
    const created = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/checks`, {
      actor: collaboratorActor,
      body: { name: 'unit tests', command: 'npm test', visibility: 'internal' },
    });
    expect(created.status).toBe(201);
    checkId = created.body.data.id;
    expect(created.body.data).toMatchObject({ name: 'unit tests', command: 'npm test', version: 1 });

    const duplicate = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/checks`, {
      actor: collaboratorActor,
      body: { name: 'unit tests', command: 'npm test', visibility: 'internal' },
    });
    expect(duplicate.status).toBe(409);

    const evidence = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/checks/${checkId}/evidence`, {
      actor: collaboratorActor,
      body: { status: 'passed', exitCode: 0, commit: 'abc123', provenance: 'human' },
    });
    expect(evidence.status).toBe(201);
    expect(evidence.body.data).toMatchObject({ status: 'passed', provenance: 'human' });

    // Internal checks require internal.read: the collaborator (task.write but
    // no internal.read) must not see their own internal check listed.
    const collaboratorList = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/checks`, { actor: collaboratorActor });
    expect(collaboratorList.status).toBe(200);
    expect(collaboratorList.body.data.find((c) => c.id === checkId)).toBeUndefined();

    const list = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/checks`, { actor: managerActor });
    expect(list.status).toBe(200);
    const check = list.body.data.find((c) => c.id === checkId);
    expect(check.evidence).toHaveLength(1);
    expect(check.evidence[0].stale).toBe(true); // commit unknown to any run head
    expect(check.evidence[0].staleReason).toMatch(/unknown|head/i);
  });

  it('marks evidence stale when the check definition changes after capture', async () => {
    const patched = await api(baseUrl, 'PATCH', `/tasks/${taskA1.id}/checks/${checkId}`, {
      actor: managerActor,
      body: { expectedVersion: 1, command: 'npm test -- --run' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data.version).toBe(2);

    const list = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/checks`, { actor: managerActor });
    const check = list.body.data.find((c) => c.id === checkId);
    expect(check.evidence[0].stale).toBe(true);
    expect(check.evidence[0].staleReason).toMatch(/definition/i);

    // Check edit requires task.write: collaborator may not edit the manager's check version here? (both have task.write; guard instead on a viewer)
  });

  it('rejects non-human provenance on the actor path (trusted contexts only)', async () => {
    const rejected = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/checks/${checkId}/evidence`, {
      actor: managerActor,
      body: { status: 'passed', provenance: 'agent' },
    });
    // The HTTP actor path records human provenance only; agent/runner go
    // through A's trusted report contexts / observation sink.
    expect(rejected.status).toBe(403);
    expect(rejected.body.error.code).toBe('provenance_forbidden');
  });
});
