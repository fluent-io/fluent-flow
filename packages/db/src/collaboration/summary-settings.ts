import { z } from 'zod';
import type { PoolClient } from 'pg';
import { getPool } from '../pool.js';
import type { CollabActor } from './auth.js';
import { authorize } from './authorize.js';
import { readRunnerProfileCatalogs, type RunnerProfileCatalog } from './chat-settings.js';
import { CollabServiceError } from './errors.js';
import { withClientTransaction } from './tx.js';

const actorSchema = z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().positive() }).strict();
const scopeSchema = z.object({ actor: actorSchema, projectId: z.string().uuid() }).strict();
export const summaryDefaultsSchema = z.object({
  enabled: z.boolean(),
  agentId: z.string().min(1).max(200).nullable(),
  profileId: z.string().min(1).max(128).nullable(),
  model: z.string().min(1).max(128).nullable(),
}).strict();
const updateSchema = scopeSchema.extend({ expectedVersion: z.number().int().positive(), defaults: summaryDefaultsSchema });
export type SummaryDefaults = z.infer<typeof summaryDefaultsSchema>;
export type SummaryAgent = {
  id: string;
  online: boolean;
  available: boolean;
  capacity: number | null;
  busy: number;
  profiles: RunnerProfileCatalog['profiles'];
};
export type ProjectSummarySettings = { version: number; defaults: SummaryDefaults; agents: SummaryAgent[] };

export async function readSummaryAgents(orgId: string, tx: Pick<PoolClient, 'query'> = getPool()): Promise<SummaryAgent[]> {
  const catalogs = await readRunnerProfileCatalogs(orgId, tx);
  return catalogs.map(catalog => {
    const profiles = catalog.supportedClaimTypes.includes('summary') ? catalog.profiles : [];
    return {
      id: catalog.id,
      online: catalog.online,
      available: catalog.online && catalog.capacity !== null && profiles.length > 0,
      capacity: catalog.capacity,
      busy: catalog.busyChat + catalog.busyWork,
      profiles,
    };
  });
}

export function validateSummarySelection(agents: SummaryAgent[], defaults: SummaryDefaults): void {
  if (!defaults.enabled) return;
  const agent = agents.find(candidate => candidate.id === defaults.agentId);
  const profile = agent?.profiles.find(candidate => candidate.id === defaults.profileId);
  if (!profile || (defaults.model !== null && !profile.models.includes(defaults.model))) {
    throw new CollabServiceError(422, 'summary_unavailable', 'Choose an available summary agent, profile and model.');
  }
}

async function read(projectId: string, tx: Pick<PoolClient, 'query'>): Promise<ProjectSummarySettings> {
  const { rows } = await tx.query<{ version: number; summary_execution_defaults: unknown; org_id: string | null }>(
    `SELECT p.version,p.summary_execution_defaults,w.org_id FROM collab_projects p
      JOIN collab_workspaces w ON w.id=p.workspace_id WHERE p.id=$1`, [projectId],
  );
  const row = rows[0];
  if (!row) throw new CollabServiceError(404, 'not_found', 'Not found.');
  return {
    version: row.version,
    defaults: summaryDefaultsSchema.parse(row.summary_execution_defaults),
    agents: row.org_id ? await readSummaryAgents(row.org_id, tx) : [],
  };
}

export async function getProjectSummarySettings(input: { actor: CollabActor; projectId: string }): Promise<ProjectSummarySettings> {
  const parsed = scopeSchema.parse(input);
  await authorize(parsed.actor, { projectId: parsed.projectId }, ['project.admin', 'internal.read']);
  return read(parsed.projectId, getPool());
}

export async function updateProjectSummarySettings(input: z.input<typeof updateSchema>): Promise<ProjectSummarySettings> {
  const parsed = updateSchema.parse(input);
  return withClientTransaction(async tx => {
    await authorize(parsed.actor, { projectId: parsed.projectId }, ['project.admin', 'internal.read'], tx);
    await tx.query('SELECT id FROM collab_projects WHERE id=$1 FOR UPDATE', [parsed.projectId]);
    const current = await read(parsed.projectId, tx);
    if (current.version !== parsed.expectedVersion) {
      throw new CollabServiceError(409, 'version_conflict', 'Settings changed. Reload before saving.', { currentVersion: current.version });
    }
    validateSummarySelection(current.agents, parsed.defaults);
    await tx.query(`UPDATE collab_projects SET summary_execution_defaults=$2,version=version+1,updated_at=NOW() WHERE id=$1`,
      [parsed.projectId, JSON.stringify(parsed.defaults)]);
    return read(parsed.projectId, tx);
  });
}
