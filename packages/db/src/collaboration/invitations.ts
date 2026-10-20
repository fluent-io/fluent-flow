import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getPool } from '../pool.js';
import { CollabServiceError } from './errors.js';
import {
  authorize,
  getRoleCapabilities,
  requireCapabilities,
  requireCapabilitySubset,
  resolveCapabilityScope,
  resolveScopeCapabilities,
} from './authorize.js';
import { enforceRateLimitBucket, rateLimitBucket } from './rate-limit.js';
import { withClientTransaction } from './tx.js';
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './passwords.js';
import type { CollabPrincipal } from './principals.js';
import { rowToPrincipal } from './principals.js';

const INVALID_INVITATION_MESSAGE = 'This invitation is invalid or no longer available.';

const createInvitationSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  workspaceId: z.string().uuid().optional(),
  projectId: z.string().uuid().nullable().default(null),
  email: z.string().email().max(320),
  roleId: z.string().uuid(),
  expiresInHours: z.number().int().min(1).max(168),
});

const acceptInvitationSchema = z.object({
  token: z.string().min(16).max(256),
  displayName: z.string().min(1).max(200),
  password: z.string().max(MAX_PASSWORD_LENGTH).optional(),
  rateLimitKey: z.string().min(8).max(256),
  actor: z
    .object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) })
    .optional(),
});

function hashInvitationToken(token: string): string {
  // Store only the hash: a DB leak must not yield redeemable invitations.
  return createHash('sha256').update(token).digest('hex');
}

function normalizeEmail(email: string | null): string | null {
  return email === null ? null : email.trim().toLowerCase();
}

export async function createCollabInvitation(input: {
  actor: { principalId: string; sessionVersion: number };
  workspaceId?: string;
  projectId?: string | null;
  email: string;
  roleId: string;
  expiresInHours: number;
}): Promise<{ id: string; url: string }> {
  const input2 = createInvitationSchema.safeParse(input);
  if (!input2.success) {
    const emailIssue = input2.error.issues.find((issue) => issue.path[0] === 'email');
    if (emailIssue) {
      throw new CollabServiceError(422, 'invalid_email', 'The email address is not valid.');
    }
    throw input2.error;
  }
  const parsed = input2.data;
  const resolved = await resolveCapabilityScope(parsed);
  const scope = { workspaceId: resolved.workspaceId, projectId: resolved.projectId };
  const actorCapabilities = await resolveScopeCapabilities(parsed.actor, scope);
  requireCapabilities(actorCapabilities, ['membership.admin']);
  // Delegation boundary: the granted role must be a subset of the inviter's
  // own effective capabilities at this exact scope — a membership-admin-only
  // role can never invite anyone as a full manager.
  const roleCapabilities = await getRoleCapabilities(parsed.roleId, resolved.workspaceId);
  requireCapabilitySubset(roleCapabilities, actorCapabilities);

  const token = randomBytes(32).toString('base64url');
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO collab_invitations
       (workspace_id, project_id, role_id, email, token_hash, invited_by_principal_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7))
     RETURNING id`,
    [
      resolved.workspaceId,
      resolved.projectId,
      parsed.roleId,
      parsed.email,
      hashInvitationToken(token),
      parsed.actor.principalId,
      parsed.expiresInHours,
    ],
  );
  // The secret lives only in this authorized response (and the invite link
  // fragment B renders); never stored in the clear, never logged.
  return { id: rows[0].id, url: `/invite#token=${token}` };
}

export async function acceptCollabInvitation(input: {
  token: string;
  displayName: string;
  password?: string;
  rateLimitKey: string;
  actor?: { principalId: string; sessionVersion: number };
}): Promise<{ principal: CollabPrincipal; workspaceId: string; projectId: string | null }> {
  const input2 = acceptInvitationSchema.parse(input);
  const bucket = rateLimitBucket('invite', input2.rateLimitKey, '');
  await enforceRateLimitBucket(bucket);

  return withClientTransaction(async (tx) => {
    const tokenHash = hashInvitationToken(input2.token);
    const consumed = await tx.query(
      `UPDATE collab_invitations
       SET accepted_at = now()
       WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       RETURNING id, workspace_id, project_id, role_id, email`,
      [tokenHash],
    );
    if (consumed.rows.length === 0) {
      const existing = await tx.query(
        `SELECT accepted_at, revoked_at, expires_at FROM collab_invitations WHERE token_hash = $1`,
        [tokenHash],
      );
      if (existing.rows.length === 0) {
        throw new CollabServiceError(404, 'invalid_invitation', INVALID_INVITATION_MESSAGE);
      }
      if (existing.rows[0].accepted_at !== null) {
        throw new CollabServiceError(409, 'invitation_already_used', INVALID_INVITATION_MESSAGE);
      }
      throw new CollabServiceError(404, 'invalid_invitation', INVALID_INVITATION_MESSAGE);
    }
    const invitation = consumed.rows[0];

    let principal: CollabPrincipal;
    if (input2.actor) {
      // Existing principal joins by signing in — the signed-in account must BE
      // the invited account (normalized email match). Never link identities by
      // email; a wrong account neither consumes nor gains anything.
      const current = await tx.query(
        `SELECT id, display_name, email, legacy_user_id, disabled_at, session_version
         FROM collab_principals WHERE id = $1 AND disabled_at IS NULL AND session_version = $2`,
        [input2.actor.principalId, input2.actor.sessionVersion],
      );
      if (current.rows.length === 0) {
        throw new CollabServiceError(401, 'unauthenticated', 'Authentication required.');
      }
      principal = rowToPrincipal(current.rows[0]);
      if (normalizeEmail(principal.email) !== normalizeEmail(invitation.email)) {
        throw new CollabServiceError(
          403,
          'wrong_account',
          'Sign in as the invited account to accept this invitation.',
        );
      }
    } else {
      if (!input2.password) {
        throw new CollabServiceError(
          422,
          'password_required',
          'Set a password to accept this invitation.',
        );
      }
      if (input2.password.length < MIN_PASSWORD_LENGTH) {
        throw new CollabServiceError(
          422,
          'invalid_password',
          `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
        );
      }
      const existing = await tx.query(
        `SELECT 1 FROM collab_principals
         WHERE lower(email) = lower($1) AND legacy_user_id IS NULL`,
        [invitation.email],
      );
      if (existing.rows.length > 0) {
        // Email already belongs to a password principal: sign in and accept
        // with the actor instead of silently merging identities.
        throw new CollabServiceError(
          409,
          'email_in_use',
          'An account with this email already exists. Sign in to accept the invitation.',
        );
      }
      const inserted = await tx.query(
        `INSERT INTO collab_principals (display_name, email)
         VALUES ($1, $2)
         RETURNING id, display_name, email, legacy_user_id, disabled_at, session_version`,
        [input2.displayName, invitation.email],
      );
      principal = rowToPrincipal(inserted.rows[0]);
      await tx.query(
        `INSERT INTO collab_password_credentials (principal_id, password_hash) VALUES ($1, $2)`,
        [principal.id, await hashPassword(input2.password)],
      );
    }

    // History: the invitation records the principal that actually redeemed it
    // (both new principals and signed-in existing ones).
    await tx.query(`UPDATE collab_invitations SET accepted_by_principal_id = $2 WHERE id = $1`, [
      invitation.id,
      principal.id,
    ]);

    // Existing membership at the invited scope: same role is an idempotent
    // grant; a different role must conflict instead of overwriting (role
    // changes go through membership.admin update paths with their own guards).
    const existingMembership = await tx.query<{ role_id: string }>(
      `SELECT role_id FROM collab_memberships
       WHERE workspace_id = $1 AND principal_id = $2
         AND ((project_id = $3) OR (project_id IS NULL AND $3::uuid IS NULL))`,
      [invitation.workspace_id, principal.id, invitation.project_id],
    );
    if (existingMembership.rows.length > 0) {
      if (existingMembership.rows[0].role_id === invitation.role_id) {
        return { principal, workspaceId: invitation.workspace_id, projectId: invitation.project_id };
      }
      throw new CollabServiceError(
        409,
        'already_member',
        'This account is already a member with a different role.',
      );
    }

    await tx.query(
      `INSERT INTO collab_memberships (workspace_id, project_id, principal_id, role_id)
       VALUES ($1, $2, $3, $4)`,
      [invitation.workspace_id, invitation.project_id, principal.id, invitation.role_id],
    );

    return { principal, workspaceId: invitation.workspace_id, projectId: invitation.project_id };
  });
}


const listInvitationsSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  workspaceId: z.string().uuid().optional(),
  projectId: z.string().uuid().nullable().default(null),
});

/** Pending invitations at a scope (membership.admin). Token hash never leaves the DB. */
export async function listCollabInvitations(input: {
  actor: { principalId: string; sessionVersion: number };
  workspaceId?: string;
  projectId?: string | null;
}): Promise<
  Array<{ id: string; email: string; roleId: string; expiresAt: string; createdAt: string }>
> {
  const input2 = listInvitationsSchema.parse(input);
  const resolved = await resolveCapabilityScope(input2);
  await authorize(input2.actor, resolved, ['membership.admin']);
  const { rows } = await getPool().query(
    `SELECT id, role_id, email, expires_at, created_at FROM collab_invitations
     WHERE workspace_id = $1 AND ((project_id = $2) OR (project_id IS NULL AND $2::uuid IS NULL))
       AND accepted_at IS NULL AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [resolved.workspaceId, resolved.projectId],
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    roleId: r.role_id,
    expiresAt: new Date(r.expires_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function revokeCollabInvitation(input: {
  actor: { principalId: string; sessionVersion: number };
  invitationId: string;
}): Promise<void> {
  if (!z.string().uuid().safeParse(input.invitationId).success) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const row = await getPool().query(
    `SELECT workspace_id, project_id FROM collab_invitations WHERE id = $1`,
    [input.invitationId],
  );
  if (row.rows.length === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  await authorize(
    input.actor,
    { workspaceId: row.rows[0].workspace_id, projectId: row.rows[0].project_id },
    ['membership.admin'],
  );
  const updated = await getPool().query(
    `UPDATE collab_invitations SET revoked_at = now()
     WHERE id = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
    [input.invitationId],
  );
  if (updated.rowCount === 0) {
    throw new CollabServiceError(409, 'invitation_already_used', INVALID_INVITATION_MESSAGE);
  }
}
