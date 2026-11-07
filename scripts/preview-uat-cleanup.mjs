import { readFileSync, writeFileSync } from 'node:fs';

const db = await import('@fluent-flow/db');
const pool = db.getPool();
const state = JSON.parse(readFileSync('/tmp/preview-uat-state.json', 'utf8'));

try {
  await pool.query(
    `UPDATE agent_tokens
     SET revoked_at = NOW()
     WHERE org_id = $1 AND agent_id = $2 AND revoked_at IS NULL`,
    [state.orgId, state.agentId],
  );
  await pool.query('DELETE FROM collab_password_credentials WHERE principal_id = $1', [state.principalId]);
  const activeRunnerTokens = Number((await pool.query(
    'SELECT COUNT(*)::integer AS count FROM agent_tokens WHERE org_id = $1 AND agent_id = $2 AND revoked_at IS NULL',
    [state.orgId, state.agentId],
  )).rows[0].count);
  const passwordCredentials = Number((await pool.query(
    'SELECT COUNT(*)::integer AS count FROM collab_password_credentials WHERE principal_id = $1',
    [state.principalId],
  )).rows[0].count);
  if (activeRunnerTokens !== 0 || passwordCredentials !== 0) throw new Error('UAT credentials remain active');
  writeFileSync('/tmp/preview-uat-cleanup.json', `${JSON.stringify({ activeRunnerTokens, passwordCredentials }, null, 2)}\n`, { mode: 0o600 });
} finally {
  await db.closePool();
}
