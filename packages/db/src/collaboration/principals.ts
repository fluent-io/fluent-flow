import { z } from 'zod';
import { getPool } from '../pool.js';
import { CollabServiceError } from './errors.js';

export type CollabPrincipal = {
  id: string;
  displayName: string;
  email: string | null;
  legacyUserId: number | null;
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
  legacy_user_id: number | null;
  disabled_at: Date | null;
  session_version: number;
}): CollabPrincipal {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    legacyUserId: row.legacy_user_id,
    disabledAt: row.disabled_at ? row.disabled_at.toISOString() : null,
    sessionVersion: row.session_version,
  };
}

const ensureGithubPrincipalSchema = z.object({
  legacyUserId: z.number().int().positive(),
  displayName: z.string().min(1).max(200),
  email: z.string().max(320).nullable(),
});

/**
 * Load-or-create the collaboration principal mirroring a legacy GitHub user.
 * The users.id link is the identity (never email). Mirrors display name/email
 * changes; never touches session_version.
 */
export async function ensureGithubPrincipal(input: {
  legacyUserId: number;
  displayName: string;
  email: string | null;
}): Promise<CollabPrincipal> {
  const { legacyUserId, displayName, email } = ensureGithubPrincipalSchema.parse(input);
  const { rows } = await getPool().query(
    `INSERT INTO collab_principals (display_name, email, legacy_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (legacy_user_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           email = EXCLUDED.email,
           updated_at = now()
     RETURNING id, display_name, email, legacy_user_id, disabled_at, session_version`,
    [displayName, email, legacyUserId],
  );
  return rowToPrincipal(rows[0]);
}

export async function getCollabPrincipal(id: string): Promise<CollabPrincipal | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  const { rows } = await getPool().query(
    `SELECT id, display_name, email, legacy_user_id, disabled_at, session_version
     FROM collab_principals WHERE id = $1`,
    [id],
  );
  return rows.length > 0 ? rowToPrincipal(rows[0]) : null;
}

/**
 * Resolve the CURRENT enabled principal for an actor (assertion-derived).
 * Session-version mismatch or a disabled principal yields null — callers turn
 * that into an unauthenticated rejection.
 */
export async function requireCurrentPrincipal(
  actor: CollabActorInput,
): Promise<CollabPrincipal> {
  const { principalId, sessionVersion } = collabActorSchema.parse(actor);
  const principal = await getCollabPrincipal(principalId);
  if (!principal || principal.disabledAt !== null || principal.sessionVersion !== sessionVersion) {
    throw new CollabServiceError(401, 'unauthenticated', 'Authentication required.');
  }
  return principal;
}
