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
  // email and avatar_url use COALESCE so callers that don't have these fields
  // (e.g., the installation webhook's sender payload carries no email) can
  // pass null without clobbering data set by a richer source (e.g., OAuth).
  const sql = `
    INSERT INTO users (github_id, login, email, avatar_url)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (github_id) DO UPDATE SET
      login = EXCLUDED.login,
      email = COALESCE(EXCLUDED.email, users.email),
      avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
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
 * Idempotently ensure a user has the given role in an org. Upserts the row —
 * if the user is already linked, their role is set to the passed value. Used
 * by the GitHub App installation webhook so the installer always lands at
 * `admin` even if a prior row existed with a lower role.
 */
export async function linkUserToOrg(
  userId: number,
  orgId: string,
  role: 'member' | 'admin' = 'member',
): Promise<void> {
  const sql = `
    INSERT INTO user_orgs (user_id, org_id, role)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role
  `;
  await query(sql, [userId, orgId, role]);
}
