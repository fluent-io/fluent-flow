import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getPool } from '../pool.js';
import { authorize } from './authorize.js';
import { chatDefaultsSchema, readChatAgents, validateChatSelection } from './chat-settings.js';
import { CollabServiceError } from './errors.js';
import { readSummaryAgents, summaryDefaultsSchema, validateSummarySelection, type SummaryDefaults } from './summary-settings.js';
import { withClientTransaction } from './tx.js';
import { legacyExecutionDefaultsSchema } from './workspaces.js';

const actorSchema = z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().positive() }).strict();
const targetSchema = z
  .object({
    agentId: z.string().min(1).max(200),
    profileId: z.string().min(1).max(128),
    model: z.string().min(1).max(128).nullable(),
  })
  .strict();
const scopeSchema = z.object({ actor: actorSchema, workspaceId: z.string().uuid(), projectId: z.string().uuid() }).strict();
const migrateSchema = scopeSchema.extend({
  expectedVersion: z.number().int().positive(),
  sourceHash: z.string().max(128).nullable(),
  chat: targetSchema,
  summary: targetSchema.nullable(),
  apply: z.boolean().default(false),
}).strict();

export type LegacyProjectExecutionInspection = {
  projectId: string;
  version: number;
  executionMode: 'chat' | 'connector';
  configured: boolean;
  sourceMappingId: string | null;
  sourceHash: string | null;
  requiresSummaryMapping: boolean;
};

export type LegacyProjectExecutionMigrationResult = {
  projectId: string;
  version: number;
  status: 'ready' | 'applied' | 'already_mapped';
  sourceMappingId: string;
  mappedSummary: boolean;
};

type ProjectRow = {
  workspace_id: string;
  org_id: string | null;
  version: number;
  execution_mode: string;
  default_agent_id: string | null;
  chat_execution_defaults: unknown;
  summary_execution_defaults: unknown;
  execution_defaults: unknown;
  linked_repo_full_name: string | null;
};

type SourceMappingRow = {
  id: string;
  host_id: string;
  repository_key: string;
  profile_ids: string[];
  default_profile_id: string | null;
  base_ref: string;
  catalog: { repositories?: { key: string }[] } | null;
};

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return Object.fromEntries(
        Object.entries(nested as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      );
    }
    return nested;
  });
}

function computeSourceHash(input: {
  defaults: unknown;
  hostId: string;
  repositoryKey: string;
  profileIds: string[];
  defaultProfileId: string | null;
  baseRef: string;
  hostCatalog: unknown;
  linkedRepoFullName: string | null;
}): string {
  return createHash('sha256')
    .update(
      stableStringify({
        defaults: input.defaults,
        mapping: {
          hostId: input.hostId,
          repositoryKey: input.repositoryKey,
          profileIds: input.profileIds,
          defaultProfileId: input.defaultProfileId,
          baseRef: input.baseRef,
        },
        hostCatalog: input.hostCatalog,
        linkedRepoFullName: input.linkedRepoFullName,
      }),
    )
    .digest('hex');
}

function requiresSummaryMapping(legacy: z.infer<typeof legacyExecutionDefaultsSchema>): boolean {
  return legacy.summary.enabled || legacy.summary.profileId !== null || legacy.summary.model !== null;
}

export async function inspectLegacyProjectExecutionDefaults(input: {
  actor: { principalId: string; sessionVersion: number };
  workspaceId: string;
  projectId: string;
}): Promise<LegacyProjectExecutionInspection> {
  const parsed = scopeSchema.parse(input);
  await authorize(parsed.actor, { projectId: parsed.projectId }, ['project.admin', 'internal.read']);
  const project = (
    await getPool().query<Pick<ProjectRow, 'workspace_id' | 'version' | 'execution_mode' | 'execution_defaults' | 'linked_repo_full_name'>>(
      `SELECT p.workspace_id, p.version, p.execution_mode, p.execution_defaults, p.linked_repo_full_name
       FROM collab_projects p WHERE p.id=$1`,
      [parsed.projectId],
    )
  ).rows[0];
  if (!project || project.workspace_id !== parsed.workspaceId) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const unconfigured: LegacyProjectExecutionInspection = {
    projectId: parsed.projectId,
    version: project.version,
    executionMode: project.execution_mode as 'chat' | 'connector',
    configured: false,
    sourceMappingId: null,
    sourceHash: null,
    requiresSummaryMapping: false,
  };
  const legacy = legacyExecutionDefaultsSchema.safeParse(project.execution_defaults);
  if (!legacy.success) return unconfigured;
  const mapping = (
    await getPool().query<Pick<SourceMappingRow, 'id' | 'host_id' | 'repository_key' | 'profile_ids' | 'default_profile_id' | 'base_ref' | 'catalog'>>(
      `SELECT m.id, m.host_id, m.repository_key, m.profile_ids, m.default_profile_id, m.base_ref, h.catalog
       FROM collab_project_host_mappings m JOIN collab_hosts h ON h.id=m.host_id
       WHERE m.id=$1 AND m.project_id=$2`,
      [legacy.data.mappingId, parsed.projectId],
    )
  ).rows[0];
  if (!mapping) return unconfigured;
  return {
    projectId: parsed.projectId,
    version: project.version,
    executionMode: project.execution_mode as 'chat' | 'connector',
    configured: true,
    sourceMappingId: mapping.id,
    sourceHash: computeSourceHash({
      defaults: project.execution_defaults,
      hostId: mapping.host_id,
      repositoryKey: mapping.repository_key,
      profileIds: mapping.profile_ids,
      defaultProfileId: mapping.default_profile_id,
      baseRef: mapping.base_ref,
      hostCatalog: mapping.catalog,
      linkedRepoFullName: project.linked_repo_full_name,
    }),
    requiresSummaryMapping: requiresSummaryMapping(legacy.data),
  };
}

export async function migrateLegacyProjectExecutionDefaults(input: {
  actor: { principalId: string; sessionVersion: number };
  workspaceId: string;
  projectId: string;
  expectedVersion: number;
  sourceHash: string | null;
  chat: { agentId: string; profileId: string; model: string | null };
  summary: { agentId: string; profileId: string; model: string | null } | null;
  apply?: boolean;
}): Promise<LegacyProjectExecutionMigrationResult> {
  const parsed = migrateSchema.parse(input);
  return withClientTransaction(async tx => {
    await authorize(parsed.actor, { projectId: parsed.projectId }, ['project.admin', 'internal.read'], tx);
    const initial = (
      await tx.query<ProjectRow>(
        `SELECT p.workspace_id, w.org_id, p.version, p.execution_mode, p.default_agent_id,
                p.chat_execution_defaults, p.summary_execution_defaults, p.execution_defaults, p.linked_repo_full_name
         FROM collab_projects p JOIN collab_workspaces w ON w.id=p.workspace_id
         WHERE p.id=$1`,
        [parsed.projectId],
      )
    ).rows[0];
    if (!initial || initial.workspace_id !== parsed.workspaceId) {
      throw new CollabServiceError(404, 'not_found', 'Not found.');
    }
    const initialLegacy = legacyExecutionDefaultsSchema.safeParse(initial.execution_defaults);
    const lockedSource = initialLegacy.success
      ? (
          await tx.query<SourceMappingRow>(
            `SELECT m.id, m.host_id, m.repository_key, m.profile_ids, m.default_profile_id, m.base_ref, h.catalog
             FROM collab_project_host_mappings m JOIN collab_hosts h ON h.id=m.host_id
             WHERE m.id=$1 AND m.project_id=$2 FOR SHARE OF m,h`,
            [initialLegacy.data.mappingId, parsed.projectId],
          )
        ).rows[0]
      : undefined;
    const project = (
      await tx.query<ProjectRow>(
        `SELECT p.workspace_id, w.org_id, p.version, p.execution_mode, p.default_agent_id,
                p.chat_execution_defaults, p.summary_execution_defaults, p.execution_defaults, p.linked_repo_full_name
         FROM collab_projects p JOIN collab_workspaces w ON w.id=p.workspace_id
         WHERE p.id=$1 FOR UPDATE OF p`,
        [parsed.projectId],
      )
    ).rows[0];
    if (!project || project.workspace_id !== parsed.workspaceId) {
      throw new CollabServiceError(404, 'not_found', 'Not found.');
    }
    await authorize(parsed.actor, { projectId: parsed.projectId }, ['project.admin', 'internal.read'], tx);
    const legacy = legacyExecutionDefaultsSchema.safeParse(project.execution_defaults);
    const pointerChanged =
      legacy.success !== initialLegacy.success ||
      (legacy.success && initialLegacy.success && legacy.data.mappingId !== initialLegacy.data.mappingId);
    if (pointerChanged) {
      throw new CollabServiceError(409, 'source_changed', 'Legacy defaults changed. Re-inspect before migrating.');
    }
    if (!legacy.success || !lockedSource) {
      throw new CollabServiceError(422, 'source_defaults_unavailable', 'Legacy execution defaults are not available for migration.');
    }
    if (!lockedSource.catalog?.repositories?.some(repo => repo.key === lockedSource.repository_key)) {
      throw new CollabServiceError(422, 'invalid_mapping', 'The selected execution mapping is not available.');
    }
    const hash = computeSourceHash({
      defaults: project.execution_defaults,
      hostId: lockedSource.host_id,
      repositoryKey: lockedSource.repository_key,
      profileIds: lockedSource.profile_ids,
      defaultProfileId: lockedSource.default_profile_id,
      baseRef: lockedSource.base_ref,
      hostCatalog: lockedSource.catalog,
      linkedRepoFullName: project.linked_repo_full_name,
    });
    if (parsed.sourceHash !== hash) {
      throw new CollabServiceError(409, 'source_changed', 'Legacy defaults changed. Re-inspect before migrating.');
    }
    const repositoryContextUsable =
      project.linked_repo_full_name !== null &&
      project.linked_repo_full_name === lockedSource.repository_key &&
      lockedSource.base_ref === 'origin/HEAD' &&
      (
        await tx.query<{ ok: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM repos r JOIN collab_workspaces w ON w.id=$2 AND w.org_id=r.org_id
             WHERE r.repo_full_name=$1
           ) AS ok`,
          [project.linked_repo_full_name, project.workspace_id],
        )
      ).rows[0].ok;
    if (!repositoryContextUsable) {
      throw new CollabServiceError(422, 'repository_context_unavailable', 'The linked repository context does not match the legacy execution source.');
    }
    const chatAgents = project.org_id ? await readChatAgents(project.org_id, tx) : [];
    const summaryAgents = project.org_id ? await readSummaryAgents(project.org_id, tx) : [];
    validateChatSelection(chatAgents, parsed.chat.agentId, {
      profileId: parsed.chat.profileId,
      model: parsed.chat.model,
      instructions: legacy.data.instructions,
    });
    const mappedSummaryDefaults: SummaryDefaults | null =
      parsed.summary === null
        ? null
        : { enabled: legacy.data.summary.enabled, agentId: parsed.summary.agentId, profileId: parsed.summary.profileId, model: parsed.summary.model };
    if (requiresSummaryMapping(legacy.data) && parsed.summary === null) {
      throw new CollabServiceError(422, 'summary_mapping_required', 'Choose an available summary agent, profile and model.');
    }
    if (!requiresSummaryMapping(legacy.data) && parsed.summary !== null) {
      throw new CollabServiceError(422, 'summary_mapping_unneeded', 'This project has no legacy summary identity to map.');
    }
    if (mappedSummaryDefaults) {
      validateSummarySelection(summaryAgents, { ...mappedSummaryDefaults, enabled: true });
    }
    const nativeChat = chatDefaultsSchema.parse(project.chat_execution_defaults);
    const nativeSummary = summaryDefaultsSchema.parse(project.summary_execution_defaults);
    const chatMatches =
      project.execution_mode === 'chat' &&
      project.default_agent_id === parsed.chat.agentId &&
      nativeChat.profileId === parsed.chat.profileId &&
      nativeChat.model === parsed.chat.model &&
      nativeChat.instructions === legacy.data.instructions;
    const summaryMatches =
      mappedSummaryDefaults === null ||
      (nativeSummary.enabled === mappedSummaryDefaults.enabled &&
        nativeSummary.agentId === mappedSummaryDefaults.agentId &&
        nativeSummary.profileId === mappedSummaryDefaults.profileId &&
        nativeSummary.model === mappedSummaryDefaults.model);
    if (chatMatches && summaryMatches) {
      return {
        projectId: parsed.projectId,
        version: project.version,
        status: 'already_mapped',
        sourceMappingId: lockedSource.id,
        mappedSummary: requiresSummaryMapping(legacy.data),
      };
    }
    const chatBaseline =
      project.default_agent_id === null && nativeChat.profileId === null && nativeChat.model === null && nativeChat.instructions === '';
    const summaryBaseline =
      nativeSummary.enabled === false && nativeSummary.agentId === null && nativeSummary.profileId === null && nativeSummary.model === null;
    const chatConflict = !chatBaseline && !chatMatches;
    const summaryConflict = mappedSummaryDefaults !== null && !summaryBaseline && !summaryMatches;
    if (chatConflict || summaryConflict) {
      throw new CollabServiceError(409, 'migration_conflict', 'Native execution settings already differ from this migration.');
    }
    if (project.version !== parsed.expectedVersion) {
      throw new CollabServiceError(409, 'version_conflict', 'This item changed. Refresh before saving.', {
        currentVersion: project.version,
      });
    }
    if (!parsed.apply) {
      return {
        projectId: parsed.projectId,
        version: project.version,
        status: 'ready',
        sourceMappingId: lockedSource.id,
        mappedSummary: requiresSummaryMapping(legacy.data),
      };
    }
    const applied = await tx.query<{ version: number }>(
      `UPDATE collab_projects
       SET execution_mode='chat', default_agent_id=$2, chat_execution_defaults=$3::jsonb,
           summary_execution_defaults=COALESCE($4::jsonb, summary_execution_defaults),
           version=version+1, updated_at=NOW()
       WHERE id=$1 RETURNING version`,
      [
        parsed.projectId,
        parsed.chat.agentId,
        JSON.stringify({
          profileId: parsed.chat.profileId,
          model: parsed.chat.model,
          instructions: legacy.data.instructions,
        }),
        mappedSummaryDefaults ? JSON.stringify(mappedSummaryDefaults) : null,
      ],
    );
    return {
      projectId: parsed.projectId,
      version: applied.rows[0].version,
      status: 'applied',
      sourceMappingId: lockedSource.id,
      mappedSummary: requiresSummaryMapping(legacy.data),
    };
  });
}
