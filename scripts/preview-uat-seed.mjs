import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const db = await import('@fluent-flow/db');
const pool = db.getPool();
const suffix = process.env.UAT_PR_NUMBER;
if (!suffix || !/^[1-9][0-9]{0,8}$/.test(suffix)) throw new Error('UAT_PR_NUMBER must be a positive integer');
const orgId = `preview-uat-${suffix}`;
const repo = `fixture/preview-uat-${suffix}`;
const owner = {
  email: `preview-uat-${suffix}@example.test`,
  login: `preview-uat-${suffix}`,
  password: `Preview-${randomBytes(18).toString('base64url')}!`,
};

await pool.query(
  `INSERT INTO orgs (id, name) VALUES ($1, $2)
   ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
  [orgId, `Preview UAT ${suffix}`],
);

const githubId = -1_000_000_000 - Number(suffix);
let user = (await pool.query('SELECT id FROM users WHERE github_id = $1', [githubId])).rows[0];
if (!user) {
  user = (await pool.query(
    `INSERT INTO users (github_id, login, email, avatar_url)
     VALUES ($1, $2, $3, NULL)
     RETURNING id`,
    [githubId, owner.login, owner.email],
  )).rows[0];
}
await pool.query(
  `INSERT INTO user_orgs (user_id, org_id, role) VALUES ($1, $2, 'admin')
   ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role`,
  [user.id, orgId],
);

const principal = await db.ensureGithubPrincipal({
  userId: user.id,
  displayName: `Preview UAT ${suffix}`,
  email: owner.email,
});
await pool.query(
  `INSERT INTO collab_password_credentials (principal_id, password_hash)
   VALUES ($1, $2)
   ON CONFLICT (principal_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`,
  [principal.id, await db.hashPassword(owner.password)],
);

const actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
const workspace = await db.bootstrapCollaborationWorkspace({
  actor,
  orgId,
  name: `Preview UAT Client ${suffix}`,
  idempotencyKey: `preview-uat-workspace-${suffix}`,
});
const project = await db.createCollabProject({
  actor,
  workspaceId: workspace.id,
  name: `Preview UAT Project ${suffix}`,
});
const task = await db.createCollabTask({
  actor,
  projectId: project.id,
  title: `Preview UAT execution ${suffix}`,
  description: 'Disposable full-stack preview acceptance task.',
});

const existingRepo = (await pool.query('SELECT id FROM repos WHERE repo_full_name = $1', [repo])).rows[0];
if (!existingRepo) {
  await pool.query(
    `INSERT INTO repos (id, org_id, repo_full_name, provider) VALUES ($1, $2, $3, 'github')`,
    [randomUUID(), orgId, repo],
  );
}

const agentId = `preview-uat-${suffix}-${randomBytes(4).toString('hex')}`;
await db.createAgent({
  id: agentId,
  orgId,
  agentType: 'test-acp',
  transport: 'long_poll',
  transportMeta: {},
  repos: [repo],
});
const token = await db.createToken({
  orgId,
  agentId,
  label: 'preview-uat',
  expiresAt: new Date(Date.now() + 35 * 60 * 1000),
});

writeFileSync('/tmp/preview-uat-state.json', JSON.stringify({
  orgId,
  repo,
  agentId,
  principalId: principal.id,
  taskId: task.id,
  taskTitle: task.title,
  email: owner.email,
  password: owner.password,
  token: token.plaintext,
}), { mode: 0o600 });

await db.closePool();
