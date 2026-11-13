import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { CollabActor } from './auth.js';
import { authorize } from './authorize.js';
import { CollabServiceError } from './errors.js';
import { withClientTransaction } from './tx.js';
import { createCollabTask } from './tasks.js';
import { insertPendingClaim } from '../queries/claims.js';

const actorSchema = z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().positive() });
const identitySchema = z.object({
  actor: actorSchema,
  claimId: z.number().int().positive(),
  commandId: z.number().int().positive(),
});
const items = z.array(z.string().min(1).max(1000)).max(30);
const digestSchema = z.object({
  goal: z.string().min(1).max(3000),
  decisions: items,
  acceptanceCriteria: items.min(1),
  openQuestions: items,
  filesTouched: z.array(z.string().min(1).max(1000).refine(value =>
    !value.startsWith('/') && !value.startsWith('\\') && !/^[A-Za-z]:/u.test(value)
    && !value.includes('\0') && !value.split(/[\\/]/u).includes('..'))).max(30),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16000);
const resultSchema = z.object({
  digest: digestSchema,
  branch: z.string().regex(/^ff\/task-[0-9a-f-]{36}$/),
  headSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
}).strict();

type Scope = { org_id: string; project_id: string; task_id: string; root_claim_id: number; repo: string | null; claim_type: string };
type Identity = z.infer<typeof identitySchema>;

async function scopeFor(input: Identity, tx: PoolClient, lock = false): Promise<Scope> {
  const { rows } = await tx.query<Scope>(`SELECT c.org_id,c.repo,c.claim_type,e.project_id,e.task_id,e.root_claim_id
    FROM agent_claims c JOIN collab_claim_executions e ON e.claim_id=c.id WHERE c.id=$1${lock ? ' FOR UPDATE OF c' : ''}`, [input.claimId]);
  if (!rows[0]) throw new CollabServiceError(404, 'not_found', 'Not found.');
  await authorize(input.actor, { projectId: rows[0].project_id }, ['internal.read', 'run.start', 'run.steer'], tx);
  if (rows[0].claim_type !== 'chat' || rows[0].repo === null) {
    throw new CollabServiceError(409, 'handoff_unavailable', 'Build handoff requires a repository session.');
  }
  return rows[0];
}

async function commandFor(input: Identity, scope: Scope, tx: PoolClient) {
  const { rows } = await tx.query(`SELECT status,result FROM agent_claim_commands
    WHERE id=$1 AND claim_id=$2 AND org_id=$3 AND kind='handoff' FOR UPDATE`, [input.commandId,input.claimId,scope.org_id]);
  if (!rows[0]) throw new CollabServiceError(404, 'not_found', 'Not found.');
  return rows[0];
}

function preparedResult(command: { status: string; result: unknown }, scope: Scope) {
  const parsed = resultSchema.safeParse(command.result);
  if (command.status !== 'acked' || !parsed.success || parsed.data.branch !== `ff/task-${scope.task_id}`) {
    throw new CollabServiceError(409, 'handoff_not_ready', 'The build handoff is not ready. Review the session and prepare it again.');
  }
  return parsed.data;
}

function renderDigest(digest: z.infer<typeof digestSchema>): string {
  return [
    `## Build handoff\n\n${digest.goal}`,
    `### Decisions\n${digest.decisions.map(item => `- ${item}`).join('\n')}`,
    `### Acceptance criteria\n${digest.acceptanceCriteria.map(item => `- ${item}`).join('\n')}`,
    `### Open questions\n${digest.openQuestions.map(item => `- ${item}`).join('\n')}`,
    `### Files touched\n${digest.filesTouched.map(item => `- ${item}`).join('\n')}`,
  ].join('\n\n');
}

export async function getCollabClaimHandoff(input: { actor: CollabActor; claimId: number; commandId: number }) {
  const parsed = identitySchema.strict().parse(input);
  return withClientTransaction(async tx => {
    const scope = await scopeFor(parsed, tx, true);
    const command = await commandFor(parsed, scope, tx);
    const started = await tx.query(`SELECT claim_id,task_id FROM collab_claim_handoffs WHERE command_id=$1`, [parsed.commandId]);
    const ready = command.status === 'acked' ? preparedResult(command, scope) : null;
    const failure = z.object({ code: z.enum(['commit_required','push_required','task_branch_required','summary_invalid','summary_interrupted','handoff_unavailable']) }).safeParse(command.result);
    return { commandId: parsed.commandId, status: command.status, prepared: ready,
      reason: failure.success ? failure.data.code : null,
      started: started.rows[0] ? { claimId: started.rows[0].claim_id as number, taskId: started.rows[0].task_id as string } : null };
  });
}

export async function startCollabClaimHandoff(input: {
  actor: CollabActor; claimId: number; commandId: number; expectedVersion: number;
  idempotencyKey: string; destinationTitle?: string;
}): Promise<{ claimId: number; taskId: string; created: boolean }> {
  const parsed = identitySchema.extend({
    expectedVersion: z.number().int().positive(), idempotencyKey: z.string().min(8).max(256),
    destinationTitle: z.string().trim().min(1).max(300).optional(),
  }).strict().parse(input);
  const hash = createHash('sha256').update(JSON.stringify({ expectedVersion: parsed.expectedVersion,
    destinationTitle: parsed.destinationTitle ?? null })).digest('hex');
  return withClientTransaction(async tx => {
    const scope = await scopeFor(parsed, tx, true);
    const command = await commandFor(parsed, scope, tx);
    if (parsed.destinationTitle !== undefined) await authorize(parsed.actor, { projectId: scope.project_id }, ['task.write'], tx);
    const existing = await tx.query(`SELECT * FROM collab_claim_handoffs WHERE command_id=$1`, [parsed.commandId]);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.request_hash !== hash || row.principal_id !== parsed.actor.principalId || row.idempotency_key !== parsed.idempotencyKey) {
        throw new CollabServiceError(409, 'handoff_already_started', 'This handoff already started unattended work.');
      }
      return { claimId: row.claim_id, taskId: row.task_id, created: false };
    }
    const prepared = preparedResult(command, scope);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`run-start:${scope.task_id}`]);
    const source = await tx.query(`SELECT version,description FROM collab_tasks WHERE id=$1${parsed.destinationTitle === undefined ? ' FOR UPDATE' : ''}`, [scope.task_id]);
    if (!source.rows[0] || source.rows[0].version !== parsed.expectedVersion) {
      throw new CollabServiceError(409, 'version_conflict', 'This item changed. Refresh before starting the build.', { currentVersion: source.rows[0]?.version });
    }
    const summary = renderDigest(prepared.digest);
    let taskId = scope.task_id;
    if (parsed.destinationTitle !== undefined) {
      const task = await createCollabTask({ actor: parsed.actor, projectId: scope.project_id,
        title: parsed.destinationTitle, description: summary }, tx);
      taskId = task.id;
    } else {
      const description = `${source.rows[0].description}\n\n${summary}`;
      if (description.length > 65535) throw new CollabServiceError(409, 'task_description_full', 'The task description is full. Create a separate build task.');
      await tx.query(`UPDATE collab_tasks SET description=$2,version=version+1,updated_at=now() WHERE id=$1`, [taskId, description]);
    }
    const claim = await insertPendingClaim({ orgId: scope.org_id, repo: scope.repo, prNumber: null, claimType: 'spec',
      headSha: prepared.headSha, payload: { source: 'collab', handed_off_from: parsed.claimId,
        handoff_command_id: parsed.commandId, handoff_base_sha: prepared.headSha, handoff_digest: prepared.digest,
        branch: prepared.branch, message: summary, instructions: summary } }, tx);
    if (!claim) throw new CollabServiceError(409, 'claim_conflict', 'The work could not be started.');
    await tx.query(`INSERT INTO collab_claim_executions(task_id,project_id,claim_id,root_claim_id,created_by_principal_id)
      VALUES ($1,$2,$3,$4,$5)`, [taskId,scope.project_id,claim.id,scope.root_claim_id,parsed.actor.principalId]);
    await tx.query(`INSERT INTO collab_claim_handoffs(command_id,task_id,claim_id,principal_id,idempotency_key,request_hash)
      VALUES ($1,$2,$3,$4,$5,$6)`, [parsed.commandId,taskId,claim.id,parsed.actor.principalId,parsed.idempotencyKey,hash]);
    return { claimId: claim.id, taskId, created: true };
  });
}
