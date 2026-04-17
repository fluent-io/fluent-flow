import { query } from '../pool.js';
import { userSchema, userOrgSchema } from '../schemas/users.js';
import type { User, UserOrg } from '../schemas/users.js';

interface UpsertUserInput {
  github_id: number;
  login: string;
  email: string | null;
  avatar_url: string | null;
}

export async function upsertUser(input: UpsertUserInput): Promise<User> {
  const sql = `
    INSERT INTO users (github_id, login, email, avatar_url)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (github_id) DO UPDATE SET
      login = EXCLUDED.login,
      email = EXCLUDED.email,
      avatar_url = EXCLUDED.avatar_url,
      updated_at = NOW()
    RETURNING *
  `;

  const result = await query(sql, [input.github_id, input.login, input.email, input.avatar_url]);
  return userSchema.parse(result.rows[0]);
}

export async function getUserOrgs(userId: number): Promise<UserOrg[]> {
  const sql = `SELECT * FROM user_orgs WHERE user_id = $1 ORDER BY org_id`;
  const result = await query(sql, [userId]);
  return result.rows.map((row: unknown) => userOrgSchema.parse(row));
}

const SELF_HOSTED_ORG_ID = 'self-hosted';

/**
 * Self-hosted onboarding: if no superadmin exists, promote this user and link
 * them to the self-hosted org as admin. Idempotent — on subsequent calls (or
 * when a superadmin already exists) the UPDATE matches no rows and the
 * user_orgs INSERT is skipped.
 */
export async function bootstrapFirstUser(userId: number): Promise<{ promoted: boolean }> {
  await query(
    `INSERT INTO orgs (id, name) VALUES ($1, 'Self-Hosted') ON CONFLICT (id) DO NOTHING`,
    [SELF_HOSTED_ORG_ID]
  );

  const promote = await query(
    `UPDATE users SET is_superadmin = true
     WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE is_superadmin = true)
     RETURNING id`,
    [userId]
  );

  if (promote.rows.length === 0) return { promoted: false };

  await query(
    `INSERT INTO user_orgs (user_id, org_id, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (user_id, org_id) DO NOTHING`,
    [userId, SELF_HOSTED_ORG_ID]
  );

  return { promoted: true };
}
