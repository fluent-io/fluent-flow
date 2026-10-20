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
  legacyOrgId: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  idempotencyKey: z.string().min(8).max(128),
});

const createProjectSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(200),
});

/**
 * Workspace bootstrap eligibility comes from CURRENT legacy roles
 * (user_orgs/superadmin) — never from session-supplied flags.
 */
export async function getCollabBootstrapEligibility(actor: {
  principalId: string;
  sessionVersion: number;
}): Promise<{ eligible: boolean; legacyOrgIds: string[] }> {
  const principal = await requireCurrentPrincipal(actor);
  if (principal.legacyUserId === null) {
    return { eligible: false, legacyOrgIds: [] };
  }
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT o.id
     FROM orgs o
     LEFT JOIN user_orgs uo ON uo.org_id = o.id AND uo.user_id = $1
     LEFT JOIN users u ON u.id = $1
     WHERE uo.role = 'admin' OR u.is_superadmin
     ORDER BY o.id`,
    [principal.legacyUserId],
  );
  return { eligible: rows.length > 0, legacyOrgIds: rows.map((r) => r.id) };
}

/**
 * Atomically create a client workspace with system roles and a manager
 * membership for the acting org admin. Idempotent per idempotencyKey; a
 * replay returns the existing workspace unchanged.
 */
export async function bootstrapCollaborationWorkspace(input: {
  actor: { principalId: string; sessionVersion: number };
  legacyOrgId: string;
  name: string;
  idempotencyKey: string;
}): Promise<{ id: string; name: string }> {
  const input2 = bootstrapSchema.parse(input);
  const principal = await requireCurrentPrincipal(input2.actor);
  if (principal.legacyUserId === null) {
    throw new CollabServiceError(
      403,
      'bootstrap_not_allowed',
      'You do not have permission to perform this action.',
    );
  }

  // Admin for the selected org (or a genuine superadmin with no user_orgs
  // row) — checked now, in DB, from current legacy state.
  const admin = await getPool().query(
    `SELECT 1
     FROM users u
     LEFT JOIN user_orgs uo ON uo.user_id = u.id AND uo.org_id = $2
     WHERE u.id = $1 AND (u.is_superadmin OR uo.role = 'admin')`,
    [principal.legacyUserId, input2.legacyOrgId],
  );
  if (admin.rows.length === 0) {
    throw new CollabServiceError(
      403,
      'bootstrap_not_allowed',
      'You do not have permission to perform this action.',
    );
  }

  return withClientTransaction(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO collab_workspaces (name, created_by_principal_id, legacy_org_id, idempotency_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, name`,
      [input2.name, principal.id, input2.legacyOrgId, input2.idempotencyKey],
    );

    let workspace = inserted.rows[0];
    if (!workspace) {
      const existing = await tx.query(
        `SELECT id, name, legacy_org_id, created_by_principal_id FROM collab_workspaces WHERE idempotency_key = $1`,
        [input2.idempotencyKey],
      );
      if (existing.rows.length === 0) {
        // Only possible under concurrent unique races the ON CONFLICT missed.
        throw new CollabServiceError(409, 'workspace_conflict', 'Workspace bootstrap conflict.');
      }
      // The idempotency key is bound to (creator, org): a different actor or
      // org replaying the key must never receive the foreign workspace.
      if (
        existing.rows[0].legacy_org_id !== input2.legacyOrgId ||
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
}): Promise<CollabProject> {
  const input2 = createProjectSchema.parse(input);
  await authorize(input2.actor, { workspaceId: input2.workspaceId }, ['project.admin']);
  const { rows } = await getPool().query(
    `INSERT INTO collab_projects (workspace_id, name) VALUES ($1, $2)
     RETURNING id, workspace_id, name, version, board_version`,
    [input2.workspaceId, input2.name],
  );
  const row = rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    version: row.version,
    boardVersion: row.board_version,
  };
}

export type CollabProject = {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  boardVersion: number;
};

export type MeProject = {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  boardVersion: number;
  executionDefaults: unknown | null;
};

export type MeWorkspace = {
  id: string;
  name: string;
  projects: MeProject[];
};

export type MeProfile = {
  workspaces: MeWorkspace[];
  /** Effective capabilities per project (B's `capabilities[projectId]` map). */
  capabilities: Record<string, CollabCapability[]>;
  /**
   * Capabilities from WORKSPACE-scope roles only — never inferred from
   * project roles — for workspace-admin settings UIs.
   */
  workspaceCapabilities: Record<string, CollabCapability[]>;
};

/**
 * Board-entry profile for GET /me. Workspace-scope memberships see ALL of
 * their workspace's projects (inheritance); project-only members see exactly
 * their authorized projects grouped under the REAL parent workspace — never
 * sibling projects, never a fabricated workspace id. Capabilities are
 * per-project only: project roles never confer workspace administration.
 */
export async function getPrincipalMeProfile(principalId: string): Promise<MeProfile> {
  const workspaces = await getPool().query<{ id: string; name: string }>(
    `SELECT DISTINCT w.id, w.name
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
    execution_defaults: unknown;
    capability: CollabCapability;
  }>(
    `SELECT p.id, p.workspace_id, p.name, p.version, p.board_version, p.execution_defaults,
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
        executionDefaults: row.execution_defaults ?? null,
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
    workspacesById.set(w.id, { id: w.id, name: w.name, projects: [] });
  }
  for (const project of projectsById.values()) {
    if (!capabilitiesByProject.get(project.id)?.has('internal.read')) project.executionDefaults = null;
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

/** Project.admin settings write (execution defaults: mapping/profiles/summary config). */
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
     RETURNING id, workspace_id, name, version, board_version, execution_defaults`,
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

/**
 * Create a custom role: workspace-scope membership.admin only, and the granted
 * capability set must be a subset of the creator's own delegable set. Role
 * definitions are create-only (contract has no role PATCH) — granted
 * privileges can therefore never be silently mutated.
 */
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
