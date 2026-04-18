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

/**
 * Idempotently link a user to an org with the given role. Used by the GitHub
 * App installation webhook to give the installer admin access to the new org.
 */
export async function linkUserToOrg(
  userId: number,
  orgId: string,
  role: 'member' | 'admin' = 'member',
): Promise<void> {
  const sql = `
    INSERT INTO user_orgs (user_id, org_id, role)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, org_id) DO NOTHING
  `;
  await query(sql, [userId, orgId, role]);
}
