import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bootstrapCollaborationWorkspace,
  createCollabProject,
  createCollabTask,
  ensureGithubPrincipal,
} from '../../src/collaboration/index.js';
import {
  getCollabProjectInsights,
  recordCollabUsage,
  recordUsageSample,
} from '../../src/collaboration/evidence.js';
import {
  ensureClaimReportingBinding,
} from '../../src/collaboration/claim-reporting.js';
import {
  withClientTransaction,
} from '../../src/collaboration/tx.js';
import {
  createToken,
} from '../../src/queries/tokens.js';
import {
  closePool,
  getPool,
} from '../../src/pool.js';
import {
  runMigrations,
} from '../../src/migrate.js';
import {
  resetCollabSchema,
  resolveCollabTestDatabaseUrl,
  seedOrgMembership,
  seedUser,
} from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const orgId = 'claim-usage-org';
const repo = 'acme/claim-usage';
const NO_SESSION = '00000000-0000-0000-0000-000000000000';
const OBSERVED_AT = new Date('2026-11-13T12:00:00.000Z');

let managerActor: { principalId: string; sessionVersion: number };
let managerVersion: number;
let projectId: string;
let taskId: string;
let legacyRunId: string;
let runnerSessionId: number;
let agentTokenId: number;

type Binding = { bindingId: string; claimId: number };

async function seedClaim(input: {
  claimedAt: string;
  withSnapshot?: boolean;
}): Promise<number> {
  const claim = await getPool().query<{ id: number }>(
    `INSERT INTO agent_claims
       (org_id, repo, pr_number, attempt, session_id, claim_type, status, payload, claimed_at, expires_at)
     VALUES ($1, $2, NULL,
       (SELECT COALESCE(MAX(attempt), 0) + 1 FROM agent_claims WHERE org_id = $1 AND repo = $2 AND pr_number IS NULL AND claim_type = 'spec'),
       $3, 'spec', 'claimed', '{}'::jsonb, $4::timestamptz, now() + interval '15 minutes')
     RETURNING id`,
    [orgId, repo, runnerSessionId, input.claimedAt],
  );
  const claimId = claim.rows[0].id;
  await getPool().query(
    `INSERT INTO collab_claim_executions
       (task_id, project_id, claim_id, root_claim_id, created_by_principal_id, created_by_session_version)
     VALUES ($1, $2, $3, $3, $4, $5)`,
    [taskId, projectId, claimId, managerActor.principalId, input.withSnapshot === false ? null : managerVersion],
  );
  return claimId;
}

async function mint(claimId: number): Promise<Binding> {
  const binding = await withClientTransaction((tx) =>
    ensureClaimReportingBinding(tx, {
      orgId,
      agentId: 'usage-runner',
      runnerSessionId,
      claimId,
      agentTokenId,
    }),
  );
  return { bindingId: binding.bindingId, claimId };
}

async function recordNative(
  binding: Binding,
  providerTurnId: string,
  tokensIn: number | null,
  tokensOut: number | null,
  costUsd: number | null,
  unavailableReason: string | null,
) {
  await recordUsageSample({
    source: { kind: 'claim', claimId: binding.claimId, reportingBindingId: binding.bindingId },
    taskId,
    providerTurnId,
    tokensIn,
    tokensOut,
    costUsd,
    unavailableReason,
  });
  await pinNativeObservedAt(binding.claimId, providerTurnId);
}

async function pinNativeObservedAt(claimId: number, providerTurnId: string) {
  await getPool().query(
    'UPDATE collab_usage_samples SET observed_at = $3::timestamptz WHERE claim_id = $1 AND provider_turn_id = $2',
    [claimId, providerTurnId, OBSERVED_AT],
  );
}

async function recordLegacy(
  providerTurnId: string,
  tokensIn: number | null,
  tokensOut: number | null,
  costUsd: number | null,
  unavailableReason: string | null,
  sessionId: string | null = null,
) {
  await recordCollabUsage({
    actor: managerActor,
    taskId,
    runId: legacyRunId,
    sessionId,
    providerTurnId,
    tokensIn,
    tokensOut,
    costUsd,
    unavailableReason,
  });
  await getPool().query(
    'UPDATE collab_usage_samples SET observed_at = $4::timestamptz WHERE run_id = $1 AND session_id = $2 AND provider_turn_id = $3',
    [legacyRunId, sessionId ?? NO_SESSION, providerTurnId, OBSERVED_AT],
  );
}

async function rowsByClaim(claimId: number, providerTurnId: string) {
  const result = await getPool().query<{
    run_id: string | null;
    session_id: string | null;
    claim_id: number | null;
    provider_turn_id: string;
    tokens_in: string | null;
    tokens_out: string | null;
    cost_usd: string | null;
    unavailable_reason: string | null;
  }>(
    `SELECT run_id, session_id, claim_id, provider_turn_id, tokens_in, tokens_out, cost_usd, unavailable_reason
       FROM collab_usage_samples WHERE claim_id = $1 AND provider_turn_id = $2`,
    [claimId, providerTurnId],
  );
  return result.rows;
}

async function rowsByTurn(providerTurnId: string) {
  const result = await getPool().query<{
    session_id: string | null;
    claim_id: number | null;
    provider_turn_id: string;
    tokens_in: string | null;
    tokens_out: string | null;
    cost_usd: string | null;
  }>(
    `SELECT session_id, claim_id, provider_turn_id, tokens_in, tokens_out, cost_usd
       FROM collab_usage_samples WHERE provider_turn_id = $1`,
    [providerTurnId],
  );
  return result.rows;
}

async function insights() {
  return getCollabProjectInsights({
    actor: managerActor,
    projectId,
    from: new Date('2026-11-13T11:30:00.000Z'),
    to: new Date('2026-11-13T12:30:00.000Z'),
  });
}

beforeAll(async () => {
  process.env.FF_COLLAB_AUTH_SECRET = 'claim-usage-test-secret-0123456789abcdef0123456789abcdef';
  await resetCollabSchema(databaseUrl);
  await runMigrations();

  const managerUserId = await seedUser(databaseUrl, { githubId: 9501, login: 'claim-usage-manager' });
  await seedOrgMembership(databaseUrl, managerUserId, orgId, 'admin');
  const manager = await ensureGithubPrincipal({
    userId: managerUserId,
    displayName: 'Claim Usage Manager',
    email: 'claim-usage-manager@example.test',
  });
  managerActor = { principalId: manager.id, sessionVersion: manager.sessionVersion };
  managerVersion = manager.sessionVersion;

  const workspace = await bootstrapCollaborationWorkspace({
    actor: managerActor,
    orgId,
    name: 'Claim Usage Workspace',
    idempotencyKey: 'claim-usage-workspace',
  });
  const project = await createCollabProject({ actor: managerActor, workspaceId: workspace.id, name: 'Usage Project' });
  projectId = project.id;
  taskId = (await createCollabTask({ actor: managerActor, projectId, title: 'Usage task' })).id;

  const hostId = (
    await getPool().query<{ id: string }>(
      `INSERT INTO collab_hosts (name, token_hash, enrolled_by_principal_id)
       VALUES ('usage-host', 'usage-host-hash', $1) RETURNING id`,
      [managerActor.principalId],
    )
  ).rows[0].id;
  const mappingId = (
    await getPool().query<{ id: string }>(
      `INSERT INTO collab_project_host_mappings (project_id, host_id, repository_key, default_profile_id)
       VALUES ($1, $2, 'acme/claim-usage', 'usage-profile') RETURNING id`,
      [projectId, hostId],
    )
  ).rows[0].id;
  legacyRunId = (
    await getPool().query<{ id: string }>(
      `INSERT INTO collab_runs
         (task_id, project_id, host_id, mapping_id, profile_id, created_by_principal_id, state)
       VALUES ($1, $2, $3, $4, 'usage-profile', $5, 'failed') RETURNING id`,
      [taskId, projectId, hostId, mappingId, managerActor.principalId],
    )
  ).rows[0].id;
  await getPool().query(
    `INSERT INTO collab_sessions (run_id, role, title) VALUES ($1, 'work', 'Legacy session')`,
    [legacyRunId],
  );

  await getPool().query(
    `INSERT INTO agents (id, org_id, agent_type, transport, transport_meta)
     VALUES ('usage-runner', $1, 'codex', 'long_poll', '{"capacity": 2}'::jsonb)`,
    [orgId],
  );
  const token = await createToken({ orgId, agentId: 'usage-runner', label: 'claim-usage' });
  agentTokenId = token.id;
  const session = await getPool().query<{ id: number }>(
    `INSERT INTO agent_sessions (org_id, agent_id, session_meta, status, last_seen_at, expires_at)
     VALUES ($1, 'usage-runner', '{"capacity": 2, "instance_id": "inst-usage", "slot_id": 0}'::jsonb,
           'online', NOW(), NOW() + interval '15 minutes') RETURNING id`,
    [orgId],
  );
  runnerSessionId = session.rows[0].id;
});

beforeEach(async () => {
  await getPool().query('DELETE FROM collab_usage_samples');
});

afterAll(async () => {
  delete process.env.FF_COLLAB_AUTH_SECRET;
  await closePool();
});

describe('native claim usage deduplication', () => {

  it('retains distinct exact attribution when two claims share the same providerTurnId', async () => {
    const claimA = await seedClaim({ claimedAt: '2026-11-13 12:10:00.000001+00' });
    const claimB = await seedClaim({ claimedAt: '2026-11-13 12:10:01.000001+00' });
    const bindingA = await mint(claimA);
    const bindingB = await mint(claimB);

    await recordNative(bindingA, 'turn-shared-001', 100, 50, 0.01, null);
    await recordNative(bindingB, 'turn-shared-001', 200, 80, 0.02, null);

    const rowsA = await rowsByClaim(claimA, 'turn-shared-001');
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].claim_id).toBe(claimA);
    expect(rowsA[0].tokens_in).toBe('100');
    expect(rowsA[0].tokens_out).toBe('50');
    expect(rowsA[0].cost_usd).toBe('0.010000');

    const rowsB = await rowsByClaim(claimB, 'turn-shared-001');
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].claim_id).toBe(claimB);
    expect(rowsB[0].tokens_in).toBe('200');
    expect(rowsB[0].tokens_out).toBe('80');
    expect(rowsB[0].cost_usd).toBe('0.020000');

    const all = await rowsByTurn('turn-shared-001');
    expect(all).toHaveLength(2);
  });

  it('replaces a cumulative snapshot within one acquisition rather than double-counting', async () => {
    const claimId = await seedClaim({ claimedAt: '2026-11-13 12:11:00.000001+00' });
    const binding = await mint(claimId);

    await recordNative(binding, 'turn-cumulative-001', 100, 50, 0.01, null);
    await recordNative(binding, 'turn-cumulative-001', 300, 150, 0.03, null);

    const rows = await rowsByClaim(claimId, 'turn-cumulative-001');
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens_in).toBe('300');
    expect(rows[0].tokens_out).toBe('150');
    expect(rows[0].cost_usd).toBe('0.030000');
  });

  it('retains the old acquisition usage and adds the new same-turn usage after claimed_at advances one microsecond', async () => {
    const claimId = await seedClaim({ claimedAt: '2026-11-13 12:12:00.000001+00' });
    const oldBinding = await mint(claimId);
    await recordNative(oldBinding, 'turn-reacquire-001', 50, 25, 0.005, null);

    await getPool().query(
      "UPDATE agent_claims SET claimed_at = claimed_at + interval '1 microsecond' WHERE id = $1",
      [claimId],
    );
    const newBinding = await mint(claimId);
    expect(newBinding.bindingId).not.toBe(oldBinding.bindingId);
    await recordNative(newBinding, 'turn-reacquire-001', 100, 50, 0.01, null);

    const all = await rowsByTurn('turn-reacquire-001');
    expect(all).toHaveLength(2);
    const values = all
      .map((row) => [Number(row.tokens_in), Number(row.tokens_out)])
      .sort((a, b) => a[0] - b[0]);
    expect(values).toEqual([[50, 25], [100, 50]]);
  });

  it('does not overwrite a legacy null-session sample with native same-turn data', async () => {
    await recordLegacy('turn-legacy-native-001', 77, 33, 0.007, null, null);

    const claimId = await seedClaim({ claimedAt: '2026-11-13 12:13:00.000001+00' });
    const binding = await mint(claimId);
    await recordNative(binding, 'turn-legacy-native-001', 999, 999, 0.99, null);

    const legacyRows = await getPool().query<{
      tokens_in: string;
      tokens_out: string;
      session_id: string;
      claim_id: number | null;
      run_id: string | null;
    }>(
      `SELECT tokens_in, tokens_out, session_id, claim_id, run_id
         FROM collab_usage_samples
        WHERE provider_turn_id = 'turn-legacy-native-001' AND session_id = $1`,
      [NO_SESSION],
    );
    expect(legacyRows.rows).toHaveLength(1);
    expect(legacyRows.rows[0].tokens_in).toBe('77');
    expect(legacyRows.rows[0].tokens_out).toBe('33');
    expect(legacyRows.rows[0].claim_id).toBeNull();
    expect(legacyRows.rows[0].run_id).toBe(legacyRunId);
  });

  it('counts a snapshot and later same-claim acquisition turns independently', async () => {
    const claimA = await seedClaim({ claimedAt: '2026-11-13 12:14:00.000001+00' });
    const bindingA = await mint(claimA);

    await recordNative(bindingA, 'native-session-snapshot', 500, 200, 0.05, null);
    await recordNative(bindingA, 'turn-ordinary-a', 100, 50, 0.01, null);
    await getPool().query("UPDATE agent_claims SET claimed_at=claimed_at+interval '1 microsecond' WHERE id=$1", [claimA]);
    const bindingB = await mint(claimA);
    await recordNative(bindingB, 'turn-ordinary-b', 200, 80, 0.02, null);

    const result = await insights();
    expect(result.usage.available).toBe(true);
    expect(result.usage.reason).toBeNull();
    expect(result.usage.tokensIn).toBe(700);
    expect(result.usage.tokensOut).toBe(280);
    expect(result.usage.costUsd).toBeCloseTo(0.07, 6);
    expect(result.usage.coverage).toEqual({ samples: 2, tokensIn: 2, tokensOut: 2, costUsd: 2 });
  });

  it('does not double-count a cumulative update in canonical insights', async () => {
    const claimId = await seedClaim({ claimedAt: '2026-11-13 12:15:00.000001+00' });
    const binding = await mint(claimId);
    await recordNative(binding, 'turn-cumulative-insight', 100, 50, 0.01, null);
    await recordNative(binding, 'turn-cumulative-insight', 300, 150, 0.03, null);

    const result = await insights();
    expect(result.usage.available).toBe(true);
    expect(result.usage.reason).toBeNull();
    expect(result.usage.tokensIn).toBe(300);
    expect(result.usage.tokensOut).toBe(150);
    expect(result.usage.costUsd).toBeCloseTo(0.03, 6);
    expect(result.usage.coverage).toEqual({ samples: 1, tokensIn: 1, tokensOut: 1, costUsd: 1 });
  });

  it('rejects usage reporting after the originating agent token is revoked and preserves the stored sample', async () => {
    const claimId = await seedClaim({ claimedAt: '2026-11-13 12:16:00.000001+00' });
    const binding = await mint(claimId);
    await recordNative(binding, 'turn-revoked-001', 1, 1, 0.001, null);

    await getPool().query('UPDATE agent_tokens SET revoked_at = NOW() WHERE id = $1', [agentTokenId]);
    try {
      await expect(
        recordNative(binding, 'turn-revoked-001', 2, 2, 0.002, null),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await getPool().query('UPDATE agent_tokens SET revoked_at = NULL WHERE id = $1', [agentTokenId]);
    }

    const rows = await rowsByClaim(claimId, 'turn-revoked-001');
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens_in).toBe('1');
    expect(rows[0].tokens_out).toBe('1');
  });

  it('rejects usage reporting from a stale binding after claimed_at advances and preserves the stored sample', async () => {
    const claimId = await seedClaim({ claimedAt: '2026-11-13 12:17:00.000001+00' });
    const staleBinding = await mint(claimId);
    await recordNative(staleBinding, 'turn-stale-001', 5, 3, 0.005, null);

    await getPool().query(
      "UPDATE agent_claims SET claimed_at = claimed_at + interval '1 microsecond' WHERE id = $1",
      [claimId],
    );

    await expect(
      recordNative(staleBinding, 'turn-stale-001', 6, 4, 0.006, null),
    ).rejects.toMatchObject({ status: 403 });

    const rows = await rowsByClaim(claimId, 'turn-stale-001');
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens_in).toBe('5');
    expect(rows[0].tokens_out).toBe('3');
  });
});
