#!/usr/bin/env node
// Non-production fixture/bootstrap CLI for isolated collaboration databases.
// Creates two client workspaces (three projects), collaborator/reviewer/
// operator principals and a GitHub admin fixture, then writes ALL generated
// credentials to a mode-0600 local file. Never logs or prints secrets.
//
// Usage:
//   node scripts/collab-fixture.mjs --database postgres://ffuser@127.0.0.1:55432/ff_fixture [--output /tmp/collab-fixture-credentials.json]
//
// Idempotent: workspaces (bootstrap keys), projects (workspace+name) and
// principals (email) are reused on re-run. Credentials are preserved across
// runs by merging with the existing output file — new credentials are only
// generated for principals created in that run.
//
// Prerequisite: `npm run build` in packages/db (imports ../dist/index.js).

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const database = argValue('--database');
const output = argValue('--output') ?? '/tmp/collab-fixture-credentials.json';

if (!database) {
  console.error('Usage: collab-fixture.mjs --database <postgres URL> [--output <file>]');
  process.exit(1);
}
const parsed = new URL(database);
if (
  !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) ||
  !/^ff_[a-z0-9_]+$/.test(parsed.pathname.replace(/^\//, ''))
) {
  console.error('Refusing: fixture requires a loopback ff_* disposable database.');
  process.exit(1);
}

process.env.DATABASE_URL = database;
const db = await import('../dist/index.js');

await db.runMigrations();

function randomPassword() {
  return randomBytes(18).toString('base64url');
}

// Merge with a previous credentials file so re-runs never destroy working logins.
let previous = { principals: [] };
if (existsSync(output)) {
  try {
    previous = JSON.parse(readFileSync(output, 'utf8'));
  } catch {
    console.error(`Existing credentials file ${output} is not valid JSON; refusing to overwrite.`);
    process.exit(1);
  }
}
const previousPasswordByPrincipalId = new Map(
  (previous.principals ?? []).filter((p) => p.principalId && p.password).map((p) => [p.principalId, p.password]),
);

const fixture = {
  database: parsed.pathname,
  workspaces: [],
  projects: [],
  principals: [],
  hosts: [],
  notes: [],
};

async function ensureLegacyAdmin(githubId, login, orgId) {
  const client = await db.getPool().connect();
  try {
    await client.query(`INSERT INTO orgs (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [
      orgId,
      `Client ${orgId}`,
    ]);
    const { rows } = await client.query(
      `INSERT INTO users (github_id, login, email, is_superadmin) VALUES ($1, $2, $3, false)
       ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`,
      [githubId, login, `${login}@example.test`],
    );
    await client.query(
      `INSERT INTO user_orgs (user_id, org_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`,
      [rows[0].id, orgId],
    );
    return rows[0].id;
  } finally {
    client.release();
  }
}

// Two GitHub org admins (client A and client B).
const adminALegacy = await ensureLegacyAdmin(41001, 'fixture-owner-a', 'fixture-org-a');
const adminBLegacy = await ensureLegacyAdmin(41002, 'fixture-owner-b', 'fixture-org-b');
const adminA = await db.ensureGithubPrincipal({
  legacyUserId: adminALegacy,
  displayName: 'Fixture Owner A',
  email: 'fixture-owner-a@example.test',
});
const adminB = await db.ensureGithubPrincipal({
  legacyUserId: adminBLegacy,
  displayName: 'Fixture Owner B',
  email: 'fixture-owner-b@example.test',
});
const adminAActor = { principalId: adminA.id, sessionVersion: adminA.sessionVersion };
const adminBActor = { principalId: adminB.id, sessionVersion: adminB.sessionVersion };

const wsA = await db.bootstrapCollaborationWorkspace({
  actor: adminAActor,
  legacyOrgId: 'fixture-org-a',
  name: 'Fixture Client A',
  idempotencyKey: 'fixture-ws-a',
});
const wsB = await db.bootstrapCollaborationWorkspace({
  actor: adminBActor,
  legacyOrgId: 'fixture-org-b',
  name: 'Fixture Client B',
  idempotencyKey: 'fixture-ws-b',
});
fixture.workspaces.push({ id: wsA.id, name: wsA.name }, { id: wsB.id, name: wsB.name });

async function roleId(workspaceId, name) {
  const { rows } = await db.getPool().query(
    `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = $2`,
    [workspaceId, name],
  );
  return rows[0].id;
}

const clientARoleId = await roleId(wsA.id, 'collaborator');
const reviewerRoleId = await roleId(wsA.id, 'reviewer');
const operatorRoleId = await roleId(wsA.id, 'operator');

async function ensureProject(workspace, actor, name) {
  const existing = await db.getPool().query(
    `SELECT id, workspace_id, name, version, board_version FROM collab_projects WHERE workspace_id = $1 AND name = $2`,
    [workspace.id, name],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    return { id: row.id, workspaceId: row.workspace_id, name: row.name, version: row.version, boardVersion: row.board_version };
  }
  return db.createCollabProject({ actor, workspaceId: workspace.id, name });
}

const projectA1 = await ensureProject(wsA, adminAActor, 'Project A1');
const projectA2 = await ensureProject(wsA, adminAActor, 'Project A2');
const projectB1 = await ensureProject(wsB, adminBActor, 'Project B1');
fixture.projects.push(projectA1, projectA2, projectB1);

async function upsertPrincipalCredential(entry) {
  const preserved = previousPasswordByPrincipalId.get(entry.principalId);
  if (preserved && !entry.password) {
    entry.password = preserved;
  }
  fixture.principals.push(entry);
}

/**
 * Reuse or create an invited principal at the given scope. Returns the
 * principal id; a generated password (new principal only) is reported to the
 * caller so it lands in the credentials file.
 */
async function ensureInvitedPrincipal({ email, displayName, inviteRoleId, workspaceId, projectId, actor = adminAActor }) {
  const existing = await db.getPool().query(
    `SELECT id FROM collab_principals WHERE lower(email) = lower($1) AND legacy_user_id IS NULL`,
    [email],
  );
  if (existing.rows.length > 0) {
    fixture.notes.push(`principal ${email} already existed; credentials preserved`);
    return { principalId: existing.rows[0].id, password: null };
  }
  const invitation = await db.createCollabInvitation({
    actor,
    workspaceId,
    projectId: projectId ?? null,
    email,
    roleId: inviteRoleId,
    expiresInHours: 24,
  });
  const password = randomPassword();
  const accepted = await db.acceptCollabInvitation({
    token: invitation.url.split('token=')[1],
    displayName,
    password,
    rateLimitKey: `fixture-${randomBytes(8).toString('hex')}`,
  });
  return { principalId: accepted.principal.id, password };
}

// Collaborator scoped to project A1 only (password login demo account).
const collaborator = await ensureInvitedPrincipal({
  email: 'fixture-collaborator@client-a.test',
  displayName: 'Fixture Collaborator',
  inviteRoleId: clientARoleId,
  workspaceId: wsA.id,
  projectId: projectA1.id,
});
await upsertPrincipalCredential({
  email: 'fixture-collaborator@client-a.test',
  password: collaborator.password,
  role: 'collaborator (project A1 only)',
  principalId: collaborator.principalId,
});

const reviewer = await ensureInvitedPrincipal({
  email: 'fixture-reviewer@client-a.test',
  displayName: 'Fixture Reviewer',
  inviteRoleId: reviewerRoleId,
  workspaceId: wsA.id,
});
await upsertPrincipalCredential({
  email: 'fixture-reviewer@client-a.test',
  password: reviewer.password,
  role: 'reviewer (workspace A)',
  principalId: reviewer.principalId,
});

const operator = await ensureInvitedPrincipal({
  email: 'fixture-operator@client-a.test',
  displayName: 'Fixture Operator',
  inviteRoleId: operatorRoleId,
  workspaceId: wsA.id,
});
await upsertPrincipalCredential({
  email: 'fixture-operator@client-a.test',
  password: operator.password,
  role: 'operator (workspace A)',
  principalId: operator.principalId,
});

const clientB = await ensureInvitedPrincipal({
  actor: adminBActor,
  email: 'fixture-collaborator@client-b.test',
  displayName: 'Fixture Client B Collaborator',
  inviteRoleId: await roleId(wsB.id, 'collaborator'),
  workspaceId: wsB.id,
  projectId: projectB1.id,
});
await upsertPrincipalCredential({email:'fixture-collaborator@client-b.test',password:clientB.password,role:'collaborator (project B1 only)',principalId:clientB.principalId});

for (const admin of [adminA, adminB]) {
  fixture.principals.push({
    email: admin.email,
    role: 'github workspace admin',
    principalId: admin.id,
    password: null,
  });
}

// Offline execution host: enrolled, never heartbeats — stays 'offline' for UAT.
const existingHost=await db.getPool().query("SELECT id,name FROM collab_hosts WHERE enrolled_by_principal_id=$1 AND name='Fixture PC (offline)' AND revoked_at IS NULL ORDER BY created_at LIMIT 1",[adminA.id]);
const host = existingHost.rows[0] ?? await db.createExecutionHost({ actor: adminAActor, name: 'Fixture PC (offline)' });
fixture.hosts.push({ id: host.id, name: host.name, note: 'offline by design (no connector will register)' });
fixture.principals.push({
  email: adminA.email,
  role: 'host owner (Fixture PC)',
  principalId: adminA.id,
  password: null,
});

writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
chmodSync(output, 0o600);

console.log(
  `Fixture ready. Workspaces: ${fixture.workspaces.length}, projects: ${fixture.projects.length}, principals: ${fixture.principals.length}`,
);
console.log(`Credentials written to ${output} (mode 0600). Do not commit or log this file.`);
await db.closePool();
