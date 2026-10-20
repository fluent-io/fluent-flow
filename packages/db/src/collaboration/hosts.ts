import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getPool } from '../pool.js';
import { CollabServiceError } from './errors.js';
import { requireCurrentPrincipal } from './principals.js';
import { authorize, getProjectCapabilities } from './authorize.js';

/**
 * Internal admins are real legacy GitHub org admins/superadmins — external
 * collaboration roles alone can never authorize a filesystem root (contract).
 */
export async function isInternalAdmin(principalId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT (
       u.is_superadmin
       OR EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.role = 'admin')
     ) AS ok
     FROM collab_principals p
     JOIN users u ON u.id = p.legacy_user_id
     WHERE p.id = $1`,
    [principalId],
  );
  return rows[0]?.ok === true;
}

async function requireInternalAdmin(actor: { principalId: string; sessionVersion: number }): Promise<void> {
  const principal = await requireCurrentPrincipal(actor);
  if (!(await isInternalAdmin(principal.id))) {
    throw new CollabServiceError(
      403,
      'forbidden',
      'You do not have permission to perform this action.',
    );
  }
}

function hashHostToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type ExecutionHost = { id: string; name: string; token: string };

const createHostSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  name: z.string().min(1).max(200),
});

export async function createExecutionHost(input: {
  actor: { principalId: string; sessionVersion: number };
  name: string;
}): Promise<ExecutionHost> {
  const input2 = createHostSchema.parse(input);
  await requireInternalAdmin(input2.actor);
  const token = `ffh_${randomBytes(24).toString('base64url')}`;
  const { rows } = await getPool().query<{ id: string; name: string }>(
    `INSERT INTO collab_hosts (name, token_hash, enrolled_by_principal_id)
     VALUES ($1, $2, $3) RETURNING id, name`,
    [input2.name, hashHostToken(token), input2.actor.principalId],
  );
  // The enrollment token lives only in this authorized response.
  return { id: rows[0].id, name: rows[0].name, token };
}

/**
 * Host authority: the ENROLLING principal or a genuine superadmin. Admin of
 * an unrelated GitHub org grants no host authority — client isolation applies
 * to infrastructure exactly like tasks. Foreign hosts are 404 (invisible).
 */
async function assertHostAuthority(
  principalId: string,
  hostId: string,
): Promise<void> {
  const { rows } = await getPool().query(
    `SELECT 1
     FROM collab_hosts h
     JOIN collab_principals p ON p.id = $1
     LEFT JOIN users u ON u.id = p.legacy_user_id
     WHERE h.id = $2
       AND (h.enrolled_by_principal_id = $1 OR u.is_superadmin)`,
    [principalId, hostId],
  );
  if (rows.length === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
}

export async function revokeExecutionHost(input: {
  actor: { principalId: string; sessionVersion: number };
  hostId: string;
}): Promise<void> {
  const principal = await requireCurrentPrincipal(input.actor);
  await assertHostAuthority(principal.id, input.hostId);
  const { rowCount } = await getPool().query(
    `UPDATE collab_hosts SET revoked_at = now(), updated_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [input.hostId],
  );
  if (rowCount === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
}

export type ExecutionHostSummary = {
  id: string;
  name: string;
  revokedAt: string | null;
  lastHeartbeatAt: string | null;
  reachability: 'online' | 'stale' | 'offline';
};

/** Hosts visible to the actor: their own enrollments, or all for a superadmin. */
export async function listExecutionHosts(actor: {
  principalId: string;
  sessionVersion: number;
}): Promise<ExecutionHostSummary[]> {
  const principal = await requireCurrentPrincipal(actor);
  const { rows } = await getPool().query(
    `SELECT h.id, h.name, h.revoked_at, h.last_heartbeat_at, u.is_superadmin
     FROM collab_hosts h
     JOIN collab_principals p ON p.id = $1
     LEFT JOIN users u ON u.id = p.legacy_user_id
     WHERE h.enrolled_by_principal_id = $1 OR u.is_superadmin
     ORDER BY h.created_at`,
    [principal.id],
  );
  return rows.map((row) => {
    const lastSeen = row.last_heartbeat_at as Date | null;
    const reachability =
      lastSeen === null
        ? 'offline'
        : Date.now() - lastSeen.getTime() < 45_000
          ? 'online'
          : Date.now() - lastSeen.getTime() < 120_000
            ? 'stale'
            : 'offline';
    return {
      id: row.id,
      name: row.name,
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
      lastHeartbeatAt: lastSeen ? lastSeen.toISOString() : null,
      reachability,
    };
  });
}

const createMappingSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  projectId: z.string().uuid(),
  hostId: z.string().uuid(),
  repositoryKey: z.string().min(1).max(200),
  baseRef: z.string().min(1).max(200).default('main'),
  profileIds: z.array(z.string().min(1).max(200)).min(1).max(50),
  defaultProfileId: z.string().min(1).max(200).optional(),
});

export type ProjectHostMapping = {
  id: string;
  projectId: string;
  hostId: string;
  repositoryKey: string;
  baseRef: string;
  profileIds: string[];
  defaultProfileId: string | null;
  version: number;
};

export async function createProjectHostMapping(input: {
  actor: { principalId: string; sessionVersion: number };
  projectId: string;
  hostId: string;
  repositoryKey: string;
  baseRef?: string;
  profileIds: string[];
  defaultProfileId?: string;
}): Promise<ProjectHostMapping> {
  const input2 = createMappingSchema.parse(input);
  // Both boundaries required: internal admin AND project admin (contract).
  await requireInternalAdmin(input2.actor);
  await authorize(input2.actor, { projectId: input2.projectId }, ['project.admin']);

  // Mapping grants a project work on this host: requires the host owner (or
  // genuine superadmin) AND project.admin — never an unrelated org admin.
  await assertHostAuthority(input2.actor.principalId, input2.hostId);
  const host = await getPool().query(`SELECT 1 FROM collab_hosts WHERE id = $1 AND revoked_at IS NULL`, [
    input2.hostId,
  ]);
  if (host.rows.length === 0) {
    throw new CollabServiceError(422, 'invalid_host', 'The selected execution host is not available.');
  }
  const defaultProfileId = input2.defaultProfileId ?? input2.profileIds[0];
  if (!input2.profileIds.includes(defaultProfileId)) {
    throw new CollabServiceError(
      422,
      'invalid_profile',
      'The default profile must be one of the allowlisted profiles.',
    );
  }
  const { rows } = await getPool().query(
    `INSERT INTO collab_project_host_mappings
       (project_id, host_id, repository_key, base_ref, profile_ids, default_profile_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, project_id, host_id, repository_key, base_ref, profile_ids, default_profile_id, version`,
    [input2.projectId, input2.hostId, input2.repositoryKey, input2.baseRef, input2.profileIds, defaultProfileId],
  );
  const row = rows[0];
  return {
    id: row.id,
    projectId: row.project_id,
    hostId: row.host_id,
    repositoryKey: row.repository_key,
    baseRef: row.base_ref,
    profileIds: row.profile_ids,
    defaultProfileId: row.default_profile_id,
    version: row.version,
  };
}

/**
 * Start-dialog read: operators (run.start + internal.read) and project admins
 * see THIS project's mappings with safe host truth (name/reachability/lastSeen
 * and the allowlisted profiles). Other projects' mappings and global catalogs
 * are never exposed. Plain collaborators (no run.start) get 404.
 */
export type ProjectMappingProfile = {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
};

export type ProjectMappingRead = {
  id: string;
  hostId: string;
  hostName: string;
  hostReachability: 'online' | 'stale' | 'offline';
  hostLastSeenAt: string | null;
  repositoryKey: string;
  baseRef: string;
  profileIds: string[];
  defaultProfileId: string | null;
  profiles: ProjectMappingProfile[];
  /** Server-allowlisted models for overrides; null → hide the override input. */
  allowedModels: string[] | null;
};

export async function listProjectHostMappings(
  actor: { principalId: string; sessionVersion: number },
  projectId: string,
): Promise<ProjectMappingRead[]> {
  const principal = await requireCurrentPrincipal(actor);
  const caps = await getProjectCapabilities(principal.id, projectId);
  const canRead = caps.has('internal.read') && (caps.has('project.admin') || caps.has('run.start'));
  if (!canRead) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const { rows } = await getPool().query(
    `SELECT m.id, m.host_id, m.repository_key, m.base_ref, m.profile_ids, m.default_profile_id,
            h.name AS host_name, h.last_heartbeat_at, h.catalog
     FROM collab_project_host_mappings m
     JOIN collab_hosts h ON h.id = m.host_id
     WHERE m.project_id = $1 ORDER BY m.created_at`,
    [projectId],
  );
  // Sanitized per-mapping profile descriptors: restricted to mapping
  // profile_ids ∩ host catalog — never notes/env/paths/global catalog.
  return rows.map((row) => {
    const catalogProfiles = Array.isArray((row.catalog as { profiles?: unknown })?.profiles)
      ? ((row.catalog as { profiles: Array<Record<string, unknown>> }).profiles)
      : [];
    const profiles = (row.profile_ids as string[]).map((profileId) => {
      const entry = catalogProfiles.find((p) => p.id === profileId) ?? {};
      return {
        id: profileId,
        name: typeof entry.name === 'string' ? entry.name : profileId,
        provider: typeof entry.provider === 'string' ? entry.provider : null,
        model: typeof entry.model === 'string' ? entry.model : null,
        modeId: typeof entry.modeId === 'string' ? entry.modeId : null,
        thinkingOptionId: typeof entry.thinkingOptionId === 'string' ? entry.thinkingOptionId : null,
      };
    });
    const lastSeen = row.last_heartbeat_at as Date | null;
    const reachability =
      lastSeen === null
        ? 'offline'
        : Date.now() - lastSeen.getTime() < 45_000
          ? 'online'
          : Date.now() - lastSeen.getTime() < 120_000
            ? 'stale'
            : 'offline';
    return {
      id: row.id,
      hostId: row.host_id,
      hostName: row.host_name,
      hostReachability: reachability,
      hostLastSeenAt: lastSeen ? lastSeen.toISOString() : null,
      repositoryKey: row.repository_key,
      baseRef: row.base_ref,
      profileIds: row.profile_ids,
      defaultProfileId: row.default_profile_id,
      profiles,
      allowedModels: profiles[0]?.model ? [profiles[0].model] : null,
    };
  });
}
