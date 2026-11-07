import { readFileSync, writeFileSync } from 'node:fs';

const db = await import('@fluent-flow/db');
const pool = db.getPool();
const state = JSON.parse(readFileSync('/tmp/preview-uat-state.json', 'utf8'));

const scalar = async (sql, params = []) => Number((await pool.query(sql, params)).rows[0].count);
const claims = (await pool.query(
  `SELECT id, status, claim_type, attempt
   FROM agent_claims
   WHERE org_id = $1
   ORDER BY id`,
  [state.orgId],
)).rows;
const sessions = (await pool.query(
  `SELECT status, COUNT(*)::integer AS count
   FROM agent_sessions
   WHERE org_id = $1 AND agent_id = $2
   GROUP BY status
   ORDER BY status`,
  [state.orgId, state.agentId],
)).rows;
const report = {
  orgs: await scalar('SELECT COUNT(*)::integer AS count FROM orgs WHERE id = $1', [state.orgId]),
  users: await scalar('SELECT COUNT(*)::integer AS count FROM users u JOIN user_orgs uo ON uo.user_id = u.id WHERE uo.org_id = $1', [state.orgId]),
  principals: await scalar('SELECT COUNT(*)::integer AS count FROM collab_principals WHERE email = $1', [state.email]),
  tasks: await scalar('SELECT COUNT(*)::integer AS count FROM collab_tasks WHERE id = $1', [state.taskId]),
  agents: await scalar('SELECT COUNT(*)::integer AS count FROM agents WHERE org_id = $1 AND id = $2', [state.orgId, state.agentId]),
  sessions,
  claims,
  events: claims.length === 0 ? 0 : await scalar('SELECT COUNT(*)::integer AS count FROM agent_claim_events WHERE claim_id = ANY($1::bigint[])', [claims.map((claim) => claim.id)]),
  requests: claims.length === 0 ? 0 : await scalar('SELECT COUNT(*)::integer AS count FROM agent_claim_requests WHERE claim_id = ANY($1::bigint[])', [claims.map((claim) => claim.id)]),
  commands: claims.length === 0 ? 0 : await scalar('SELECT COUNT(*)::integer AS count FROM agent_claim_commands WHERE claim_id = ANY($1::bigint[])', [claims.map((claim) => claim.id)]),
  migrations: await scalar('SELECT COUNT(*)::integer AS count FROM drizzle.__drizzle_migrations'),
};

writeFileSync('/tmp/preview-uat-report.json', `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await db.closePool();
