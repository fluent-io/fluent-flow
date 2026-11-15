import { z } from 'zod';
import { getPool } from '../pool.js';
import { CollabServiceError } from './errors.js';
import {
  authorize,
  getProjectCapabilities as getProjectCaps,
  requireCapabilities,
  requireCapabilitySubset,
  resolveScopeCapabilities,
  resolveCapabilityScope,
} from './authorize.js';
import { SYSTEM_ROLE_PRESETS } from './capabilities.js';
import type { CollabCapability } from './capabilities.js';
import { requireCurrentPrincipal } from './principals.js';
import { withClientTransaction } from './tx.js';

const bootstrapSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  orgId: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  idempotencyKey: z.string().min(8).max(128),
});

const createProjectSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(200),
  repoFullName: z.string().min(1).max(400).optional(),
});

const ensureDefaultWorkspaceSchema = z.object({
  orgId: z.string().min(1).max(128),
  createdByPrincipalId: z.string().uuid().nullable(),
});

const DEFAULT_WORKSPACE_IDEMPOTENCY_PREFIX = 'default-workspace:';

export function defaultWorkspaceIdempotencyKey(orgId: string): string {
  return `${DEFAULT_WORKSPACE_IDEMPOTENCY_PREFIX}${orgId}`;
}

export async function ensureDefaultWorkspace(
  orgId: string,
  opts: { createdByPrincipalId?: string | null } = {},
): Promise<{ id: string; name: string; created: boolean } | null> {
  const input = ensureDefaultWorkspaceSchema.parse({
    orgId,
    createdByPrincipalId: opts.createdByPrincipalId ?? null,
  });
  const idempotencyKey = defaultWorkspaceIdempotencyKey(input.orgId);
  return withClientTransaction(async (tx) => {
    await tx.query(`SELECT id FROM orgs WHERE id = $1 FOR UPDATE`, [input.orgId]);
    const existing = await tx.query<{ id: string; name: string }>(
      `SELECT id, name FROM collab_workspaces
       WHERE org_id = $1
       ORDER BY (idempotency_key = $2) DESC, created_at, id
       LIMIT 1`,
      [input.orgId, idempotencyKey],
    );
    if (existing.rows[0]) {
      return { id: existing.rows[0].id, name: existing.rows[0].name, created: false };
    }

    const inserted = await tx.query<{ id: string; name: string }>(
      `INSERT INTO collab_workspaces (name, created_by_principal_id, org_id, idempotency_key)
       SELECT left(o.name, 200), $2, o.id, $3 FROM orgs o WHERE o.id = $1
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, name`,
      [input.orgId, input.createdByPrincipalId, idempotencyKey],
    );
    const workspace = inserted.rows[0];
    if (!workspace) {
      const winner = await tx.query<{ id: string; name: string; org_id: string }>(
        `SELECT id, name, org_id FROM collab_workspaces WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      if (!winner.rows[0]) return null;
      if (winner.rows[0].org_id !== input.orgId) {
        throw new CollabServiceError(409, 'workspace_conflict', 'Default workspace provisioning conflict.');
      }
      return { id: winner.rows[0].id, name: winner.rows[0].name, created: false };
    }

    for (const preset of SYSTEM_ROLE_PRESETS) {
      await tx.query(
        `INSERT INTO collab_roles (workspace_id, name, capabilities, is_system)
         VALUES ($1, $2, $3, true)`,
        [workspace.id, preset.name, preset.capabilities],
      );
    }
    return { id: workspace.id, name: workspace.name, created: true };
  });
}

export async function enrollOrgAdminInDefaultWorkspaces(principalId: string): Promise<string[]> {
  const parsed = z.string().uuid().parse(principalId);
  const { rows } = await getPool().query<{ workspace_id: string }>(
    `INSERT INTO collab_memberships (workspace_id, principal_id, role_id)
     SELECT w.id, p.id, r.id
     FROM collab_principals p
     JOIN user_orgs uo ON uo.user_id = p.user_id AND uo.role = 'admin'
     JOIN collab_workspaces w
       ON w.org_id = uo.org_id AND w.idempotency_key = 'default-workspace:' || uo.org_id
     JOIN collab_roles r ON r.workspace_id = w.id AND r.name = 'manager' AND r.is_system
     WHERE p.id = $1 AND p.disabled_at IS NULL
     ON CONFLICT (workspace_id, principal_id) WHERE project_id IS NULL DO NOTHING
     RETURNING workspace_id`,
    [parsed],
  );
  return rows.map((row) => row.workspace_id);
}

export async function getCollabBootstrapEligibility(actor: {
  principalId: string;
  sessionVersion: number;
}): Promise<{ eligible: boolean; orgIds: string[] }> {
  const principal = await requireCurrentPrincipal(actor);
  if (principal.userId === null) {
    return { eligible: false, orgIds: [] };
  }
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT o.id
     FROM orgs o
     LEFT JOIN user_orgs uo ON uo.org_id = o.id AND uo.user_id = $1
     LEFT JOIN users u ON u.id = $1
     WHERE uo.role = 'admin' OR u.is_superadmin
     ORDER BY o.id`,
    [principal.userId],
  );
  return { eligible: rows.length > 0, orgIds: rows.map((r) => r.id) };
}

export async function bootstrapCollaborationWorkspace(input: {
  actor: { principalId: string; sessionVersion: number };
  orgId: string;
  name: string;
  idempotencyKey: string;
}): Promise<{ id: string; name: string }> {
  const input2 = bootstrapSchema.parse(input);
  const principal = await requireCurrentPrincipal(input2.actor);
  if (principal.userId === null) {
    throw new CollabServiceError(
      403,
      'bootstrap_not_allowed',
      'You do not have permission to perform this action.',
    );
  }

  const admin = await getPool().query(
    `SELECT 1
     FROM users u
     LEFT JOIN user_orgs uo ON uo.user_id = u.id AND uo.org_id = $2
     WHERE u.id = $1 AND (u.is_superadmin OR uo.role = 'admin')`,
    [principal.userId, input2.orgId],
  );
  if (admin.rows.length === 0) {
    throw new CollabServiceError(
      403,
      'bootstrap_not_allowed',
      'You do not have permission to perform this action.',
    );
  }
  if (input2.idempotencyKey.startsWith(DEFAULT_WORKSPACE_IDEMPOTENCY_PREFIX)) {
    throw new CollabServiceError(
      422,
      'invalid_idempotency_key',
      'The selected idempotency key is reserved.',
    );
  }

  return withClientTransaction(async (tx) => {
    await tx.query(`SELECT id FROM orgs WHERE id = $1 FOR UPDATE`, [input2.orgId]);
    const inserted = await tx.query(
      `INSERT INTO collab_workspaces (name, created_by_principal_id, org_id, idempotency_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, name`,
      [input2.name, principal.id, input2.orgId, input2.idempotencyKey],
    );

    let workspace = inserted.rows[0];
    if (!workspace) {
      const existing = await tx.query(
        `SELECT id, name, org_id, created_by_principal_id FROM collab_workspaces WHERE idempotency_key = $1`,
        [input2.idempotencyKey],
      );
      if (existing.rows.length === 0) {
        throw new CollabServiceError(409, 'workspace_conflict', 'Workspace bootstrap conflict.');
      }
      if (
        existing.rows[0].org_id !== input2.orgId ||
        existing.rows[0].created_by_principal_id !== principal.id
      ) {
        throw new CollabServiceError(409, 'bootstrap_conflict', 'Workspace bootstrap conflict.');
      }
      return { id: existing.rows[0].id, name: existing.rows[0].name };
    }

    const roleIds = new Map<string, string>();
    for (const preset of SYSTEM_ROLE_PRESETS) {
      const roleRow = await tx.query<{ id: string }>(
        `INSERT INTO collab_roles (workspace_id, name, capabilities, is_system)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [workspace.id, preset.name, preset.capabilities],
      );
      roleIds.set(preset.name, roleRow.rows[0].id);
    }

    await tx.query(
      `INSERT INTO collab_memberships (workspace_id, principal_id, role_id)
       VALUES ($1, $2, $3)`,
      [workspace.id, principal.id, roleIds.get('manager')],
    );

    return { id: workspace.id, name: workspace.name };
  });
}

export async function createCollabProject(input: {
  actor: { principalId: string; sessionVersion: number };
  workspaceId: string;
  name: string;
  repoFullName?: string;
}): Promise<CollabProject> {
  const input2 = createProjectSchema.parse(input);
  await authorize(input2.actor, { workspaceId: input2.workspaceId }, ['project.admin']);
  const repoFullName = input2.repoFullName ?? null;
  if (repoFullName !== null) {
    const repo = await getPool().query(
      `SELECT 1 FROM repos r
       JOIN collab_workspaces w ON w.org_id = r.org_id
       WHERE w.id = $1 AND r.repo_full_name = $2`,
      [input2.workspaceId, repoFullName],
    );
    if (repo.rows.length === 0) {
      throw new CollabServiceError(422, 'invalid_repo', 'The selected repository is not available.');
    }
  }
  const { rows } = await getPool().query(
    `INSERT INTO collab_projects (workspace_id, name, linked_repo_full_name) VALUES ($1, $2, $3)
     RETURNING id, workspace_id, name, version, board_version, linked_repo_full_name`,
    [input2.workspaceId, input2.name, repoFullName],
  );
  const row = rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    version: row.version,
    boardVersion: row.board_version,
    linkedRepoFullName: row.linked_repo_full_name,
  };
}

export type CollabProject = {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  boardVersion: number;
  linkedRepoFullName: string | null;
};

export type MeProject = {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  boardVersion: number;
  linkedRepoFullName: string | null;
  executionDefaults: unknown | null;
  executionMode?: 'chat' | 'connector';
};

export type MeWorkspace = {
  id: string;
  name: string;
  orgId: string | null;
  projects: MeProject[];
};

export type MeProfile = {
  workspaces: MeWorkspace[];
  capabilities: Record<string, CollabCapability[]>;
  workspaceCapabilities: Record<string, CollabCapability[]>;
};

export async function getPrincipalMeProfile(principalId: string): Promise<MeProfile> {
  const workspaces = await getPool().query<{ id: string; name: string; org_id: string | null }>(
    `SELECT DISTINCT w.id, w.name, w.org_id
     FROM collab_memberships m
     JOIN collab_workspaces w ON w.id = m.workspace_id
     WHERE m.principal_id = $1
     ORDER BY w.name, w.id`,
    [principalId],
  );
  const projects = await getPool().query<{
    id: string;
    workspace_id: string;
    name: string;
    version: number;
    board_version: number;
    linked_repo_full_name: string | null;
    execution_defaults: unknown;
    execution_mode: 'chat' | 'connector';
    capability: CollabCapability;
  }>(
    `SELECT p.id, p.workspace_id, p.name, p.version, p.board_version, p.linked_repo_full_name, p.execution_defaults, p.execution_mode,
            cap.capability
     FROM collab_projects p
     JOIN collab_memberships m
       ON m.workspace_id = p.workspace_id AND (m.project_id IS NULL OR m.project_id = p.id)
     JOIN collab_roles r ON r.id = m.role_id
     CROSS JOIN LATERAL unnest(r.capabilities) AS cap(capability)
     WHERE m.principal_id = $1
     ORDER BY p.name, p.id`,
    [principalId],
  );

  const capabilitiesByProject = new Map<string, Set<CollabCapability>>();
  const projectsById = new Map<string, MeProject>();
  for (const row of projects.rows) {
    let project = projectsById.get(row.id);
    if (!project) {
      project = {
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.name,
        version: row.version,
        boardVersion: row.board_version,
        linkedRepoFullName: row.linked_repo_full_name,
        executionDefaults: row.execution_defaults ?? null,
        executionMode: row.execution_mode,
      };
      projectsById.set(row.id, project);
    }
    let caps = capabilitiesByProject.get(row.id);
    if (!caps) {
      caps = new Set<CollabCapability>();
      capabilitiesByProject.set(row.id, caps);
    }
    caps.add(row.capability);
  }

  const workspacesById = new Map<string, MeWorkspace>();
  for (const w of workspaces.rows) {
    workspacesById.set(w.id, { id: w.id, name: w.name, orgId: w.org_id, projects: [] });
  }
  for (const project of projectsById.values()) {
    if (!capabilitiesByProject.get(project.id)?.has('internal.read')) {
      project.executionDefaults = null;
      delete project.executionMode;
    }
    workspacesById
      .get(project.workspaceId)!
      .projects.push(project);
  }

  const workspaceCaps = await getPool().query<{ id: string; capability: CollabCapability }>(
    `SELECT w.id, cap.capability
     FROM collab_workspaces w
     JOIN collab_memberships m ON m.workspace_id = w.id AND m.project_id IS NULL
     JOIN collab_roles r ON r.id = m.role_id
     CROSS JOIN LATERAL unnest(r.capabilities) AS cap(capability)
     WHERE m.principal_id = $1`,
    [principalId],
  );
  const workspaceCapabilities: Record<string, CollabCapability[]> = {};
  for (const row of workspaceCaps.rows) {
    (workspaceCapabilities[row.id] ??= []).push(row.capability);
  }

  const capabilities: Record<string, CollabCapability[]> = {};
  for (const [projectId, caps] of capabilitiesByProject) {
    capabilities[projectId] = [...caps];
  }

  return {
    workspaces: [...workspacesById.values()],
    capabilities,
    workspaceCapabilities,
  };
}

const updateDefaultsSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  projectId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  executionDefaults: z.object({
    mappingId: z.string().uuid(),
    profileId: z.string().min(1).max(200),
    model: z.string().min(1).max(200).nullable().default(null),
    instructions: z.string().max(20000).default(''),
    summary: z.object({
      enabled: z.boolean(),
      profileId: z.string().min(1).max(200).nullable().default(null),
      model: z.string().min(1).max(200).nullable().default(null),
    }).strict().default({ enabled: false, profileId: null, model: null }),
  }).strict(),
});

export async function updateProjectExecutionDefaults(input: {
  actor: { principalId: string; sessionVersion: number };
  projectId: string;
  expectedVersion: number;
  executionDefaults: Record<string, unknown>;
}): Promise<CollabProject> {
  const input2 = updateDefaultsSchema.parse(input);
  await authorize(input2.actor, { projectId: input2.projectId }, ['project.admin', 'internal.read']);
  return withClientTransaction(async tx => {
  const mapping = (await tx.query<{
    profile_ids: string[]; repository_key: string; revoked_at: Date | null;
    catalog: { repositories?: { key: string }[]; profiles?: { id: string; model?: string | null }[] } | null;
  }>(`SELECT m.profile_ids,m.repository_key,h.catalog,h.revoked_at
      FROM collab_project_host_mappings m JOIN collab_hosts h ON h.id=m.host_id
      WHERE m.id=$1 AND m.project_id=$2 FOR SHARE OF m,h`,
    [input2.executionDefaults.mappingId,input2.projectId])).rows[0];
  if (!mapping || mapping.revoked_at || !mapping.catalog?.repositories?.some(repo => repo.key === mapping.repository_key)) {
    throw new CollabServiceError(422, 'invalid_mapping', 'The selected execution mapping is not available.');
  }
  const validateProfile = (profileId: string, model: string | null, summary = false) => {
    const profile = mapping.catalog?.profiles?.find(item => item.id === profileId);
    if (!mapping.profile_ids.includes(profileId) || !profile) {
      throw new CollabServiceError(422, 'invalid_profile', summary ? 'The selected summary profile is not available.' : 'The selected execution profile is not available.');
    }
    if (model !== null && model !== profile.model) {
      throw new CollabServiceError(422, 'model_not_allowed', 'The selected model is not allowed for this profile.');
    }
  };
  validateProfile(input2.executionDefaults.profileId,input2.executionDefaults.model);
  const summary = input2.executionDefaults.summary;
  if (summary.enabled && !summary.profileId || summary.model && !summary.profileId) {
    throw new CollabServiceError(422, 'invalid_profile', 'Choose an available summary profile.');
  }
  if (summary.profileId) validateProfile(summary.profileId,summary.model,true);
  const updated = await tx.query(
    `UPDATE collab_projects
     SET execution_defaults = $1, version = version + 1, updated_at = now()
     WHERE id = $2 AND version = $3
     RETURNING id, workspace_id, name, version, board_version, linked_repo_full_name, execution_defaults`,
    [JSON.stringify(input2.executionDefaults), input2.projectId, input2.expectedVersion],
  );
  if (updated.rows.length === 0) {
    const current = await tx.query(`SELECT version FROM collab_projects WHERE id = $1`, [
      input2.projectId,
    ]);
    throw new CollabServiceError(409, 'version_conflict', 'This item changed. Refresh before saving.', {
      currentVersion: current.rows[0]?.version,
    });
  }
  const row = updated.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    version: row.version,
    boardVersion: row.board_version,
    linkedRepoFullName: row.linked_repo_full_name,
  };
  });
}

const createRoleSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(100),
  capabilities: z
    .array(
      z.enum([
        'task.read',
        'task.write',
        'comment.write',
        'internal.read',
        'run.start',
        'run.steer',
        'run.cancel',
        'delivery.accept',
        'project.admin',
        'membership.admin',
      ]),
    )
    .min(1),
});

export async function createWorkspaceRole(input: {
  actor: { principalId: string; sessionVersion: number };
  workspaceId: string;
  name: string;
  capabilities: string[];
}): Promise<{ id: string; workspaceId: string; name: string; capabilities: string[] }> {
  const input2 = createRoleSchema.parse(input);
  const actorCaps = await resolveScopeCapabilities(input2.actor, {
    workspaceId: input2.workspaceId,
  });
  requireCapabilities(actorCaps, ['membership.admin']);
  requireCapabilitySubset(new Set(input2.capabilities), actorCaps);
  const { rows } = await getPool().query(
    `INSERT INTO collab_roles (workspace_id, name, capabilities, is_system)
     VALUES ($1, $2, $3, false)
     RETURNING id, workspace_id, name, capabilities`,
    [input2.workspaceId, input2.name, input2.capabilities],
  );
  return {
    id: rows[0].id,
    workspaceId: rows[0].workspace_id,
    name: rows[0].name,
    capabilities: rows[0].capabilities,
  };
}

export async function listWorkspaceRoles(input: {
  actor: { principalId: string; sessionVersion: number };
  workspaceId: string;
  projectId?: string;
}): Promise<Array<{ id: string; name: string; capabilities: string[]; isSystem: boolean }>> {
  const parsed = z.object({
    actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
    workspaceId: z.string().uuid(), projectId: z.string().uuid().optional(),
  }).parse(input);
  if (parsed.projectId) {
    const scope = await resolveCapabilityScope({ projectId: parsed.projectId });
    if (scope.workspaceId !== parsed.workspaceId) throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const capabilities = await resolveScopeCapabilities(parsed.actor, parsed.projectId ? { projectId: parsed.projectId } : { workspaceId: parsed.workspaceId });
  requireCapabilities(capabilities, ['membership.admin']);
  const { rows } = await getPool().query(
    `SELECT id, name, capabilities, is_system FROM collab_roles WHERE workspace_id = $1 ORDER BY is_system DESC, name`,
    [parsed.workspaceId],
  );
  return rows
    .filter(row => !parsed.projectId || row.capabilities.every((capability: CollabCapability) => capabilities.has(capability)))
    .map((r) => ({ id: r.id, name: r.name, capabilities: r.capabilities, isSystem: r.is_system }));
}
