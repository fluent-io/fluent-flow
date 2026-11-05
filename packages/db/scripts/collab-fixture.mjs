#!/usr/bin/env node

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

const demoOverviews = [
  [projectA1, {
    description:
      'Disposable Node.js arithmetic demo used to try task execution end to end. It has no web server or UI. ' +
      'The add function starts out intentionally broken so an execution task has a real bug to fix.',
    run: 'Nothing to start: this is a library with no web server. Inspect the code in the disposable demo repository prepared by the local runner.',
    test: 'Run `npm test` in the demo repository. It uses Node\'s built-in test runner; the add tests fail until the intentionally broken add function is fixed.',
  }],
  [projectA2, {
    description:
      'Permission-isolation example in Fixture Client A. Use it to check that people invited only to Project A1 cannot see this project.',
    run: 'Nothing to run: no repository or execution host is configured for this project.',
    test: 'Sign in as the Project A1 collaborator and confirm this project is not listed. No automated tests are configured.',
  }],
  [projectB1, {
    description:
      'Belongs to the separate client Fixture Client B and demonstrates client isolation: people in Fixture Client A cannot see it.',
    run: 'Nothing to run: no application is configured for this project.',
    test: 'Sign in as a Fixture Client A user and confirm this project is not listed. No automated tests are configured.',
  }],
];
for (const [project, text] of demoOverviews) {
  await db.getPool().query(
    `INSERT INTO collab_project_overviews (project_id, description, run_instructions, test_instructions)
     VALUES ($1, $2, $3, $4) ON CONFLICT (project_id) DO NOTHING`,
    [project.id, text.description, text.run, text.test],
  );
}

async function upsertPrincipalCredential(entry) {
  const preserved = previousPasswordByPrincipalId.get(entry.principalId);
  if (preserved && !entry.password) {
    entry.password = preserved;
  }
  fixture.principals.push(entry);
}

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

async function ensureDemoOwnerPassword(admin) {
  let password = previousPasswordByPrincipalId.get(admin.id) ?? null;
  const existing = await db.getPool().query(
    'SELECT password_hash FROM collab_password_credentials WHERE principal_id=$1', [admin.id],
  );
  let stored = existing.rows[0]?.password_hash;
  if (existing.rows.length === 0) {
    password ??= randomPassword();
    const inserted = await db.getPool().query(
      'INSERT INTO collab_password_credentials(principal_id,password_hash) VALUES($1,$2) ON CONFLICT(principal_id) DO NOTHING RETURNING password_hash',
      [admin.id, await db.hashPassword(password)],
    );
    stored = inserted.rows[0]?.password_hash ?? (await db.getPool().query(
      'SELECT password_hash FROM collab_password_credentials WHERE principal_id=$1', [admin.id],
    )).rows[0]?.password_hash;
  }
  if (password && stored && await db.verifyPassword(password, stored)) return password;
  fixture.notes.push(`owner ${admin.email} has existing credentials without a matching saved password; existing credentials preserved`);
  return null;
}

const ownerPasswords = new Map();
for (const admin of [adminA, adminB]) {
  const password = await ensureDemoOwnerPassword(admin);
  ownerPasswords.set(admin.id, password);
  fixture.principals.push({
    email: admin.email,
    role: 'github workspace admin',
    principalId: admin.id,
    password,
  });
}

const existingHost=await db.getPool().query("SELECT id,name FROM collab_hosts WHERE enrolled_by_principal_id=$1 AND name='Fixture PC (offline)' AND revoked_at IS NULL ORDER BY created_at LIMIT 1",[adminA.id]);
const host = existingHost.rows[0] ?? await db.createExecutionHost({ actor: adminAActor, name: 'Fixture PC (offline)' });
fixture.hosts.push({ id: host.id, name: host.name, note: 'offline by design (no connector will register)' });
fixture.principals.push({
  email: adminA.email,
  role: 'host owner (Fixture PC)',
  principalId: adminA.id,
  password: ownerPasswords.get(adminA.id),
});

writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
chmodSync(output, 0o600);

console.log(
  `Fixture ready. Workspaces: ${fixture.workspaces.length}, projects: ${fixture.projects.length}, principals: ${fixture.principals.length}`,
);
console.log(`Credentials written to ${output} (mode 0600). Do not commit or log this file.`);
await db.closePool();
