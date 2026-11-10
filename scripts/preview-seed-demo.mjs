import { randomUUID } from 'node:crypto';
import {
  addCollabMember,
  bootstrapCollaborationWorkspace,
  createAgent,
  createCollabProject,
  createCollabTask,
  ensureGithubPrincipal,
  getCollabProjectOverview,
  getPool,
  hashPassword,
  listCollabMembers,
  listWorkspaceRoles,
  updateCollabProjectOverview,
} from '@fluent-flow/db';

const password = 'password';
const orgId = 'self-hosted';
const workspaceName = 'Self-Hosted Workspace';
const projectName = 'Demo Project';
const roles = [
  { email: 'superadmin@site.com', login: 'preview-superadmin', role: 'admin', superadmin: true, githubId: -2000000001 },
  { email: 'admin@site.com', login: 'preview-admin', role: 'admin', superadmin: false, githubId: -2000000002 },
  { email: 'member@site.com', login: 'preview-member', role: 'member', superadmin: false, githubId: -2000000003, workspaceRole: 'collaborator' },
  { email: 'viewer@site.com', login: 'preview-viewer', role: 'member', superadmin: false, githubId: -2000000004, workspaceRole: 'viewer' },
];

const pool = getPool();
await pool.query(
  `INSERT INTO orgs (id, name) VALUES ($1, $2)
   ON CONFLICT (id) DO NOTHING`,
  [orgId, 'Self-Hosted'],
);

const provisioned = {};
for (const role of roles) {
  let user = (await pool.query('SELECT id, is_superadmin FROM users WHERE github_id = $1', [role.githubId])).rows[0];
  if (!user) {
    user = (await pool.query(
      `INSERT INTO users (github_id, login, email, is_superadmin)
       VALUES ($1, $2, $3, $4)
       RETURNING id, is_superadmin`,
      [role.githubId, role.login, role.email, role.superadmin],
    )).rows[0];
  }
  if (role.superadmin && !user.is_superadmin) {
    await pool.query('UPDATE users SET is_superadmin = true WHERE id = $1', [user.id]);
  }
  await pool.query(
    `INSERT INTO user_orgs (user_id, org_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role`,
    [user.id, orgId, role.role],
  );
  const principal = await ensureGithubPrincipal({
    legacyUserId: user.id,
    displayName: role.login,
    email: role.email,
  });
  await pool.query(
    `INSERT INTO collab_password_credentials (principal_id, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (principal_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`,
    [principal.id, await hashPassword(password)],
  );
  provisioned[role.email] = { principalId: principal.id, sessionVersion: principal.sessionVersion };
}

const adminActor = { principalId: provisioned['admin@site.com'].principalId, sessionVersion: provisioned['admin@site.com'].sessionVersion };
const workspace = await bootstrapCollaborationWorkspace({
  actor: adminActor,
  legacyOrgId: orgId,
  name: workspaceName,
  idempotencyKey: 'preview-demo-workspace',
});

const existingProjects = await pool.query(
  'SELECT id FROM collab_projects WHERE workspace_id = $1 AND name = $2',
  [workspace.id, projectName],
);
let projectId = existingProjects.rows[0]?.id;
if (!projectId) {
  const project = await createCollabProject({ actor: adminActor, workspaceId: workspace.id, name: projectName });
  projectId = project.id;
}

const overview = await getCollabProjectOverview({ actor: adminActor, projectId });
if (!overview.description) {
  await updateCollabProjectOverview({
    actor: adminActor,
    projectId,
    expectedVersion: overview.version,
    description: 'Disposable demo project for the preview environment. Exercise the board, dispatch a claim, and watch pipelines without touching real repositories.',
    runInstructions: 'No build required. Any task on this project runs against the demo fixture repository.',
    testInstructions: 'The fixture repository ships a failing `npm test` on purpose, so a fix claim has something to turn green.',
  });
}

const existingTasks = await pool.query(
  'SELECT id FROM collab_tasks WHERE project_id = $1 AND title = $2',
  [projectId, 'Fix the add function in the fixture repository'],
);
if (existingTasks.rows.length === 0) {
  await createCollabTask({
    actor: adminActor,
    projectId,
    title: 'Fix the add function in the fixture repository',
    description: 'The fixture repository ships with an intentionally broken add implementation. Dispatch a claim and let the agent make `npm test` green.',
    priority: 'normal',
  });
}

const repoFullName = 'fluent-io/preview-demo';
const existingRepo = (await pool.query('SELECT id FROM repos WHERE repo_full_name = $1', [repoFullName])).rows[0];
if (!existingRepo) {
  await pool.query(
    `INSERT INTO repos (id, org_id, repo_full_name, provider)
     VALUES ($1, $2, $3, 'github')`,
    [randomUUID(), orgId, repoFullName],
  );
}

const agentId = 'preview-demo-agent';
const existingAgent = (await pool.query('SELECT id FROM agents WHERE id = $1', [agentId])).rows[0];
if (!existingAgent) {
  await createAgent({
    id: agentId,
    orgId,
    agentType: 'test-acp',
    transport: 'long_poll',
    transportMeta: { provider: 'claude-code', capacity: 4, deployment: 'local' },
    repos: [repoFullName],
  });
}

const members = (await listCollabMembers({ actor: adminActor, workspaceId: workspace.id })).members;
const membersByPrincipal = new Map(members.map(m => [m.principalId, m]));
const workspaceRoles = await listWorkspaceRoles({ actor: adminActor, workspaceId: workspace.id });
const roleIdByName = new Map(workspaceRoles.map(r => [r.name, r.id]));

for (const role of roles.filter(r => r.workspaceRole)) {
  const entry = provisioned[role.email];
  const existing = membersByPrincipal.get(entry.principalId);
  if (existing && existing.roleId === roleIdByName.get(role.workspaceRole)) continue;
  try {
    await addCollabMember({
      actor: adminActor,
      workspaceId: workspace.id,
      principalId: entry.principalId,
      roleId: roleIdByName.get(role.workspaceRole),
    });
  } catch (err) {
    if (err?.code !== 'already_member' && err?.details?.code !== 'already_member') throw err;
  }
}

await pool.end();
console.log(
  `Preview demo logins ready (password: ${password}): ${roles.map(r => r.email).join(', ')} — workspace "${workspaceName}" with project "${projectName}"`,
);
