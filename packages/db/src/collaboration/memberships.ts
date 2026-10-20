import { z } from 'zod';
import type { PoolClient } from 'pg';
import { getPool } from '../pool.js';
import { withClientTransaction } from './tx.js';
import {
  getRoleCapabilities,
  getWorkspaceCapabilities,
  requireCapabilities,
  requireCapabilitySubset,
  resolveCapabilityScope,
  resolveScopeCapabilities,
} from './authorize.js';
import { CollabServiceError } from './errors.js';

const memberScopeSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  workspaceId: z.string().uuid().optional(),
  projectId: z.string().uuid().nullable().default(null),
  principalId: z.string().uuid(),
  roleId: z.string().uuid(),
});

const removeMemberSchema = memberScopeSchema.omit({ roleId: true });

export type CollabMembership = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  principalId: string;
  roleId: string;
  version: number;
};

function membershipRow(row: Record<string, unknown>): CollabMembership {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    projectId: (row.project_id as string | null) ?? null,
    principalId: row.principal_id as string,
    roleId: row.role_id as string,
    version: row.version as number,
  };
}

/**
 * Delegation boundary shared by invite/add/update: the granted role's
 * capabilities must be a subset of the actor's effective capabilities at that
 * exact scope. Returns the checked actor capability set.
 */
async function requireDelegableRole(
  actor: { principalId: string; sessionVersion: number },
  scope: { workspaceId?: string; projectId?: string | null },
  roleId: string,
): Promise<void> {
  const resolved = await resolveCapabilityScope(scope);
  const fullScope = { workspaceId: resolved.workspaceId, projectId: resolved.projectId };
  const actorCapabilities = await resolveScopeCapabilities(actor, fullScope);
  requireCapabilities(actorCapabilities, ['membership.admin']);
  const roleCapabilities = await getRoleCapabilities(roleId, resolved.workspaceId);
  requireCapabilitySubset(roleCapabilities, actorCapabilities);
}

/**
 * 409 when a WORKSPACE-SCOPED admin-capable membership would lose its admin
 * (removal or demotion) and no other workspace admin remains. Project-scope
 * rows and same-role updates never trigger it. Runs INSIDE the caller's
 * transaction, which must hold the workspace membership advisory lock so
 * concurrent mutual removals serialize.
 */
async function guardAdminRetention(
  tx: PoolClient,
  input: {
    workspaceId: string;
    principalId: string;
    scopeIsWorkspace: boolean;
    removing: boolean;
    newRoleId?: string;
  },
): Promise<void> {
  if (!input.scopeIsWorkspace) return;
  const current = await tx.query<{ capabilities: string[] }>(
    `SELECT r.capabilities FROM collab_memberships m
     JOIN collab_roles r ON r.id = m.role_id
     WHERE m.workspace_id = $1 AND m.principal_id = $2 AND m.project_id IS NULL
     FOR UPDATE`,
    [input.workspaceId, input.principalId],
  );
  if (current.rows.length === 0) return;
  if (!current.rows[0].capabilities.includes('membership.admin')) return;
  if (!input.removing && input.newRoleId) {
    const replacement = await tx.query<{ capabilities: string[] }>(
      `SELECT capabilities FROM collab_roles WHERE id = $1 AND workspace_id = $2`,
      [input.newRoleId, input.workspaceId],
    );
    if (replacement.rows[0]?.capabilities.includes('membership.admin')) return;
  }
  const others = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM collab_memberships m
     JOIN collab_roles r ON r.id = m.role_id
     WHERE m.workspace_id = $1 AND m.project_id IS NULL AND m.principal_id <> $2
       AND 'membership.admin' = ANY(r.capabilities)`,
    [input.workspaceId, input.principalId],
  );
  if (others.rows[0].n === 0) {
    throw new CollabServiceError(
      409,
      'last_admin',
      'At least one workspace membership administrator must remain.',
    );
  }
}

function membershipLock(tx: PoolClient, workspaceId: string): Promise<unknown> {
  // Serialize workspace-scope membership mutations (add is excluded but
  // harmless); prevents concurrent mutual removals from dropping the last
  // admin between the check and the write.
  return tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`collab-memberships:${workspaceId}`]);
}

export async function addCollabMember(input: {
  actor: { principalId: string; sessionVersion: number };
  workspaceId?: string;
  projectId?: string | null;
  principalId: string;
  roleId: string;
}): Promise<CollabMembership> {
  const input2 = memberScopeSchema.parse(input);
  const resolved = await resolveCapabilityScope(input2);
  const scope = { workspaceId: resolved.workspaceId, projectId: resolved.projectId };
  await requireDelegableRole(input2.actor, scope, input2.roleId);

  const principalExists = await getPool().query(
    `SELECT 1 FROM collab_principals WHERE id = $1 AND disabled_at IS NULL`,
    [input2.principalId],
  );
  if (principalExists.rows.length === 0) {
    throw new CollabServiceError(422, 'invalid_member', 'The selected account is not available.');
  }

  return withClientTransaction(async (tx) => {
    const existing = await tx.query(
      `SELECT id FROM collab_memberships
       WHERE workspace_id = $1 AND principal_id = $2
         AND ((project_id = $3) OR (project_id IS NULL AND $3::uuid IS NULL))`,
      [resolved.workspaceId, input2.principalId, resolved.projectId],
    );
    if (existing.rows.length > 0) {
      throw new CollabServiceError(
        409,
        'already_member',
        'This account is already a member at this scope.',
      );
    }
    const { rows } = await tx.query(
      `INSERT INTO collab_memberships (workspace_id, project_id, principal_id, role_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [resolved.workspaceId, resolved.projectId, input2.principalId, input2.roleId],
    );
    return membershipRow(rows[0]);
  });
}

export async function updateCollabMemberRole(input: {
  actor: { principalId: string; sessionVersion: number };
  workspaceId?: string;
  projectId?: string | null;
  principalId: string;
  roleId: string;
  expectedVersion: number;
}): Promise<CollabMembership> {
  const input2 = memberScopeSchema
    .extend({ expectedVersion: z.number().int().min(1) })
    .parse(input);
  const resolved = await resolveCapabilityScope(input2);
  const scope = { workspaceId: resolved.workspaceId, projectId: resolved.projectId };
  await requireDelegableRole(input2.actor, scope, input2.roleId);

  return withClientTransaction(async (tx) => {
    const current = await tx.query(
      `SELECT * FROM collab_memberships
       WHERE workspace_id = $1 AND principal_id = $2
         AND ((project_id = $3) OR (project_id IS NULL AND $3::uuid IS NULL))
       FOR UPDATE`,
      [resolved.workspaceId, input2.principalId, resolved.projectId],
    );
    if (current.rows.length === 0) {
      throw new CollabServiceError(404, 'not_found', 'Not found.');
    }
    if (current.rows[0].version !== input2.expectedVersion) {
      throw new CollabServiceError(
        409,
        'version_conflict',
        'This item changed. Refresh before saving.',
        { currentVersion: current.rows[0].version },
      );
    }
    await membershipLock(tx, resolved.workspaceId);
    await guardAdminRetention(tx, {
      workspaceId: resolved.workspaceId,
      principalId: input2.principalId,
      scopeIsWorkspace: resolved.projectId === null,
      removing: false,
      newRoleId: input2.roleId,
    });

    const { rows } = await tx.query(
      `UPDATE collab_memberships SET role_id = $1, version = version + 1, updated_at = now()
       WHERE id = $2 RETURNING *`,
      [input2.roleId, current.rows[0].id],
    );
    return membershipRow(rows[0]);
  });
}

export async function removeCollabMember(input: {
  actor: { principalId: string; sessionVersion: number };
  workspaceId?: string;
  projectId?: string | null;
  principalId: string;
}): Promise<void> {
  const input2 = removeMemberSchema.parse(input);
  const resolved = await resolveCapabilityScope(input2);
  const scope = { workspaceId: resolved.workspaceId, projectId: resolved.projectId };
  const actorCapabilities = await resolveScopeCapabilities(input2.actor, scope);
  requireCapabilities(actorCapabilities, ['membership.admin']);

  await withClientTransaction(async (tx) => {
    const current = await tx.query(
      `SELECT * FROM collab_memberships
       WHERE workspace_id = $1 AND principal_id = $2
         AND ((project_id = $3) OR (project_id IS NULL AND $3::uuid IS NULL))
       FOR UPDATE`,
      [resolved.workspaceId, input2.principalId, resolved.projectId],
    );
    if (current.rows.length === 0) {
      throw new CollabServiceError(404, 'not_found', 'Not found.');
    }
    await membershipLock(tx, resolved.workspaceId);
    await guardAdminRetention(tx, {
      workspaceId: resolved.workspaceId,
      principalId: input2.principalId,
      scopeIsWorkspace: resolved.projectId === null,
      removing: true,
    });
    await tx.query(`DELETE FROM collab_memberships WHERE id = $1`, [current.rows[0].id]);
  });
}

export async function listCollabMembers(input:{actor:{principalId:string;sessionVersion:number};workspaceId?:string;projectId?:string|null;limit?:number;cursor?:string}) {
  const parsed=z.object({workspaceId:z.string().uuid().optional(),projectId:z.string().uuid().nullable().default(null),limit:z.number().int().min(1).max(100).default(100),cursor:z.string().uuid().optional()}).parse(input);
  const scope=await resolveCapabilityScope(parsed);
  const capabilities=await resolveScopeCapabilities(input.actor,scope);
  requireCapabilities(capabilities,['membership.admin']);
  const workspaceCapabilities=await getWorkspaceCapabilities(input.actor.principalId,scope.workspaceId);
  const includeInherited=workspaceCapabilities.has('membership.admin');
  const {rows}=await getPool().query(`SELECT m.id,m.principal_id AS "principalId",p.display_name AS "displayName",p.email,m.role_id AS "roleId",r.name AS "roleName",m.version,m.project_id AS "projectId"
    FROM collab_memberships m JOIN collab_principals p ON p.id=m.principal_id JOIN collab_roles r ON r.id=m.role_id
    WHERE m.workspace_id=$1 AND (m.project_id=$2 OR (m.project_id IS NULL AND ($2::uuid IS NULL OR $5)))
      AND ($3::uuid IS NULL OR m.id>$3) ORDER BY m.id LIMIT $4`,[scope.workspaceId,scope.projectId,parsed.cursor??null,parsed.limit+1,includeInherited]);
  return {members:rows.slice(0,parsed.limit),nextCursor:rows.length>parsed.limit?rows[parsed.limit-1].id:null};
}

/** Assignment choices reveal only enabled people who can read this project. */
export async function listCollabAssignees(input:{actor:{principalId:string;sessionVersion:number};projectId:string}) {
  const projectId=z.string().uuid().parse(input.projectId);
  await resolveScopeCapabilities(input.actor,{projectId}).then(caps=>requireCapabilities(caps,['task.write']));
  const {rows}=await getPool().query(`SELECT DISTINCT principal.id,principal.display_name AS "displayName"
    FROM collab_projects project JOIN collab_memberships member ON member.workspace_id=project.workspace_id AND (member.project_id IS NULL OR member.project_id=project.id)
    JOIN collab_roles role ON role.id=member.role_id JOIN collab_principals principal ON principal.id=member.principal_id
    WHERE project.id=$1 AND principal.disabled_at IS NULL AND 'task.read'=ANY(role.capabilities)
    ORDER BY "displayName",principal.id LIMIT 200`,[projectId]);
  return rows;
}
