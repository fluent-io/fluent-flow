import { z } from 'zod';
import { getPool } from '../pool.js';
import { CollabServiceError } from './errors.js';
import { collabActorSchema, requireCurrentPrincipal } from './principals.js';
import type { CollabCapability } from './capabilities.js';

export async function getProjectCapabilities(
  principalId: string,
  projectId: string,
): Promise<Set<CollabCapability>> {
  const { rows } = await getPool().query<{ capability: CollabCapability }>(
    `SELECT DISTINCT cap.capability
     FROM collab_projects p
     JOIN collab_memberships m
       ON m.workspace_id = p.workspace_id AND (m.project_id IS NULL OR m.project_id = p.id)
     JOIN collab_roles r ON r.id = m.role_id
     CROSS JOIN LATERAL unnest(r.capabilities) AS cap(capability)
     WHERE p.id = $1 AND m.principal_id = $2`,
    [projectId, principalId],
  );
  return new Set(rows.map((r) => r.capability));
}

export async function getWorkspaceCapabilities(
  principalId: string,
  workspaceId: string,
): Promise<Set<CollabCapability>> {
  const { rows } = await getPool().query<{ capability: CollabCapability }>(
    `SELECT DISTINCT cap.capability
     FROM collab_memberships m
     JOIN collab_roles r ON r.id = m.role_id
     CROSS JOIN LATERAL unnest(r.capabilities) AS cap(capability)
     WHERE m.workspace_id = $1 AND m.principal_id = $2 AND m.project_id IS NULL`,
    [workspaceId, principalId],
  );
  return new Set(rows.map((r) => r.capability));
}

export function requireCapabilities(
  capabilities: Set<CollabCapability>,
  needed: readonly CollabCapability[],
): void {
  if (capabilities.size === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const missing = needed.filter((capability) => !capabilities.has(capability));
  if (missing.length > 0) {
    throw new CollabServiceError(
      403,
      'forbidden',
      'You do not have permission to perform this action.',
    );
  }
}

export type CapabilityScope = { workspaceId?: string; projectId?: string | null };

export async function resolveCapabilityScope(
  scope: CapabilityScope,
): Promise<{ workspaceId: string; projectId: string | null }> {
  if (scope.projectId) {
    const { rows } = await getPool().query<{ workspace_id: string }>(
      `SELECT workspace_id FROM collab_projects WHERE id = $1`,
      [scope.projectId],
    );
    if (rows.length === 0) {
      throw new CollabServiceError(404, 'not_found', 'Not found.');
    }
    return { workspaceId: rows[0].workspace_id, projectId: scope.projectId };
  }
  if (scope.workspaceId) {
    return { workspaceId: scope.workspaceId, projectId: null };
  }
  throw new CollabServiceError(500, 'internal_error', 'Configuration error. Contact support.');
}

export async function authorize(
  actor: { principalId: string; sessionVersion: number },
  scope: CapabilityScope,
  needed: readonly CollabCapability[],
): Promise<void> {
  const capabilities = await resolveScopeCapabilities(actor, scope);
  requireCapabilities(capabilities, needed);
}

export async function resolveScopeCapabilities(
  actor: { principalId: string; sessionVersion: number },
  scope: CapabilityScope,
): Promise<Set<CollabCapability>> {
  const { principalId } = collabActorSchema.parse(actor);
  await requireCurrentPrincipal(actor);
  if (scope.projectId) {
    return getProjectCapabilities(principalId, scope.projectId);
  }
  if (scope.workspaceId) {
    return getWorkspaceCapabilities(principalId, scope.workspaceId);
  }
  throw new CollabServiceError(500, 'internal_error', 'Configuration error. Contact support.');
}

export async function getRoleCapabilities(
  roleId: string,
  workspaceId: string,
): Promise<Set<CollabCapability>> {
  const { rows } = await getPool().query<{ capabilities: CollabCapability[] }>(
    `SELECT capabilities FROM collab_roles WHERE id = $1 AND workspace_id = $2`,
    [roleId, workspaceId],
  );
  if (rows.length === 0) {
    throw new CollabServiceError(422, 'invalid_role', 'The selected role is not available.');
  }
  return new Set(rows[0].capabilities);
}

export function requireCapabilitySubset(
  granted: Set<CollabCapability>,
  delegable: Set<CollabCapability>,
): void {
  for (const capability of granted) {
    if (!delegable.has(capability)) {
      throw new CollabServiceError(
        403,
        'cannot_delegate',
        'You do not have permission to perform this action.',
      );
    }
  }
}

export function parseUuid(id: string): string {
  if (!z.string().uuid().safeParse(id).success) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  return id;
}
