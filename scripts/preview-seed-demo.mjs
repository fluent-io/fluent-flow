import { ensureGithubPrincipal, getPool, hashPassword } from '@fluent-flow/db';

const password = 'password';
const orgId = 'self-hosted';
const roles = [
  { email: 'superadmin@site.com', login: 'preview-superadmin', role: 'admin', superadmin: true, githubId: -2000000001 },
  { email: 'admin@site.com', login: 'preview-admin', role: 'admin', superadmin: false, githubId: -2000000002 },
  { email: 'member@site.com', login: 'preview-member', role: 'member', superadmin: false, githubId: -2000000003 },
];

const pool = getPool();
await pool.query(
  `INSERT INTO orgs (id, name) VALUES ($1, $2)
   ON CONFLICT (id) DO NOTHING`,
  [orgId, 'Self-Hosted'],
);

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
}

await pool.end();
console.log('Preview demo logins ready: admin@site.com, member@site.com, superadmin@site.com (password: password)');
