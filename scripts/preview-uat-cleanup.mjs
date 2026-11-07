import { writeFileSync } from 'node:fs';

const db = await import('@fluent-flow/db');
const pool = db.getPool();
const suffix = process.env.UAT_PR_NUMBER;
if (!suffix || !/^[1-9][0-9]{0,8}$/.test(suffix)) throw new Error('UAT_PR_NUMBER must be a positive integer');
const orgId = `preview-uat-${suffix}`;
const agentPattern = `preview-uat-${suffix}-%`;
const email = `preview-uat-${suffix}@example.test`;

try {
  await pool.query(
    `UPDATE agent_tokens
     SET revoked_at = NOW()
     WHERE org_id = $1 AND agent_id LIKE $2 AND revoked_at IS NULL`,
    [orgId, agentPattern],
  );
  await pool.query(
    `DELETE FROM collab_password_credentials
     WHERE principal_id IN (SELECT id FROM collab_principals WHERE email = $1)`,
    [email],
  );
  const activeRunnerTokens = Number((await pool.query(
    'SELECT COUNT(*)::integer AS count FROM agent_tokens WHERE org_id = $1 AND agent_id LIKE $2 AND revoked_at IS NULL',
    [orgId, agentPattern],
  )).rows[0].count);
  const passwordCredentials = Number((await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM collab_password_credentials c
     JOIN collab_principals p ON p.id = c.principal_id
     WHERE p.email = $1`,
    [email],
  )).rows[0].count);
  if (activeRunnerTokens !== 0 || passwordCredentials !== 0) throw new Error('UAT credentials remain active');
  writeFileSync('/tmp/preview-uat-cleanup.json', `${JSON.stringify({ activeRunnerTokens, passwordCredentials }, null, 2)}\n`, { mode: 0o600 });
} finally {
  await db.closePool();
}
