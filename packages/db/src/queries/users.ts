import { query } from '../pool';
import { userSchema, userOrgSchema } from '../schemas/users';
import type { User, UserOrg } from '../schemas/users';

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
