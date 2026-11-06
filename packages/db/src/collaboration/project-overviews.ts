import { z } from 'zod';
import { getPool } from '../pool.js';
import { authorize } from './authorize.js';
import { CollabServiceError } from './errors.js';
import { withClientTransaction } from './tx.js';
import type { PoolClient } from 'pg';

export type CollabProjectOverview = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  name: string;
  version: number;
  boardVersion: number;
  description: string;
  runInstructions: string;
  testInstructions: string;
};

const actorSchema = z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) });
const overviewText = z.string().max(20000);

const getSchema = z.object({ actor: actorSchema, projectId: z.string().uuid() });

const updateSchema = z
  .object({
    actor: actorSchema,
    projectId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    name: z.string().min(1).max(200).optional(),
    description: overviewText.optional(),
    runInstructions: overviewText.optional(),
    testInstructions: overviewText.optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.name !== undefined ||
      input.description !== undefined ||
      input.runInstructions !== undefined ||
      input.testInstructions !== undefined,
    { message: 'Nothing to update.' },
  );

const SELECT_OVERVIEW = `SELECT p.id, p.workspace_id, w.name AS workspace_name, p.name, p.version, p.board_version,
       COALESCE(o.description, '') AS description,
       COALESCE(o.run_instructions, '') AS run_instructions,
       COALESCE(o.test_instructions, '') AS test_instructions
     FROM collab_projects p
     JOIN collab_workspaces w ON w.id = p.workspace_id
     LEFT JOIN collab_project_overviews o ON o.project_id = p.id
     WHERE p.id = $1`;

async function readOverview(client: Pick<PoolClient, 'query'>, projectId: string): Promise<CollabProjectOverview> {
  const { rows } = await client.query(SELECT_OVERVIEW, [projectId]);
  const row = rows[0];
  if (!row) throw new CollabServiceError(404, 'not_found', 'Not found.');
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    name: row.name,
    version: row.version,
    boardVersion: row.board_version,
    description: row.description,
    runInstructions: row.run_instructions,
    testInstructions: row.test_instructions,
  };
}

export async function getCollabProjectOverview(input: {
  actor: { principalId: string; sessionVersion: number };
  projectId: string;
}): Promise<CollabProjectOverview> {
  const parsed = getSchema.parse(input);
  await authorize(parsed.actor, { projectId: parsed.projectId }, []);
  return readOverview(getPool(), parsed.projectId);
}

export async function updateCollabProjectOverview(input: {
  actor: { principalId: string; sessionVersion: number };
  projectId: string;
  expectedVersion: number;
  name?: string;
  description?: string;
  runInstructions?: string;
  testInstructions?: string;
}): Promise<CollabProjectOverview> {
  const parsed = updateSchema.parse(input);
  await authorize(parsed.actor, { projectId: parsed.projectId }, ['project.admin']);
  return withClientTransaction(async (tx) => {
    const locked = await tx.query<{ version: number }>(
      `SELECT version FROM collab_projects WHERE id = $1 FOR UPDATE`,
      [parsed.projectId],
    );
    if (locked.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
    const currentVersion = locked.rows[0].version;
    if (currentVersion !== parsed.expectedVersion) {
      throw new CollabServiceError(409, 'version_conflict', 'This item changed. Refresh before saving.', {
        currentVersion,
      });
    }
    await tx.query(
      `UPDATE collab_projects
       SET name = COALESCE($2, name), version = version + 1, updated_at = now()
       WHERE id = $1`,
      [parsed.projectId, parsed.name ?? null],
    );
    await tx.query(
      `INSERT INTO collab_project_overviews
         (project_id, description, run_instructions, test_instructions, updated_by_principal_id)
       VALUES ($1, COALESCE($2, ''), COALESCE($3, ''), COALESCE($4, ''), $5)
       ON CONFLICT (project_id) DO UPDATE SET
         description = COALESCE($2, collab_project_overviews.description),
         run_instructions = COALESCE($3, collab_project_overviews.run_instructions),
         test_instructions = COALESCE($4, collab_project_overviews.test_instructions),
         updated_by_principal_id = $5,
         updated_at = now()`,
      [
        parsed.projectId,
        parsed.description ?? null,
        parsed.runInstructions ?? null,
        parsed.testInstructions ?? null,
        parsed.actor.principalId,
      ],
    );
    return readOverview(tx, parsed.projectId);
  });
}
