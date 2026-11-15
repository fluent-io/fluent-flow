import { z } from 'zod';
import type { PoolClient } from 'pg';
import { getPool } from '../pool.js';
import { CollabServiceError } from './errors.js';

export type CollabPrincipal = {
  id: string;
  displayName: string;
  email: string | null;
  userId: number | null;
  disabledAt: string | null;
  sessionVersion: number;
};

export const collabActorSchema = z.object({
  principalId: z.string().uuid(),
  sessionVersion: z.number().int().min(1),
});
export type CollabActorInput = z.infer<typeof collabActorSchema>;

export function rowToPrincipal(row: {
  id: string;
  display_name: string;
  email: string | null;
  user_id: number | null;
  disabled_at: Date | null;
  session_version: number;
}): CollabPrincipal {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    userId: row.user_id,
    disabledAt: row.disabled_at ? row.disabled_at.toISOString() : null,
    sessionVersion: row.session_version,
  };
}

const ensureGithubPrincipalSchema = z.object({
  userId: z.number().int().positive(),
  displayName: z.string().min(1).max(200),
  email: z.string().max(320).nullable(),
});

export async function ensureGithubPrincipal(input: {
  userId: number;
  displayName: string;
  email: string | null;
}): Promise<CollabPrincipal> {
  const { userId, displayName, email } = ensureGithubPrincipalSchema.parse(input);
  const { rows } = await getPool().query(
    `INSERT INTO collab_principals (display_name, email, user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           email = EXCLUDED.email,
           updated_at = now()
     RETURNING id, display_name, email, user_id, disabled_at, session_version`,
    [displayName, email, userId],
  );
  return rowToPrincipal(rows[0]);
}

export async function getCollabPrincipal(id: string, executor?: Pick<PoolClient, 'query'>): Promise<CollabPrincipal | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  const { rows } = await (executor ?? getPool()).query(
    `SELECT id, display_name, email, user_id, disabled_at, session_version
     FROM collab_principals WHERE id = $1`,
    [id],
  );
  return rows.length > 0 ? rowToPrincipal(rows[0]) : null;
}

export async function requireCurrentPrincipal(
  actor: CollabActorInput,
  executor?: Pick<PoolClient, 'query'>,
): Promise<CollabPrincipal> {
  const { principalId, sessionVersion } = collabActorSchema.parse(actor);
  const principal = await getCollabPrincipal(principalId, executor);
  if (!principal || principal.disabledAt !== null || principal.sessionVersion !== sessionVersion) {
    throw new CollabServiceError(401, 'unauthenticated', 'Authentication required.');
  }
  return principal;
}
