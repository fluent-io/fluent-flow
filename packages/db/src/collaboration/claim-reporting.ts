import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { getPool } from '../pool.js';
import { withClientTransaction } from './tx.js';
import { getProjectCapabilities } from './authorize.js';
import { CollabServiceError } from './errors.js';
import {
  REPORTING_CAPABILITIES,
  reportingServerKey,
  type ClaimReportingContext,
  type ReportingCapability,
  type ReportSource,
} from './runs.js';

export type { ReportSource, ClaimReportingContext };

type Executor = Pick<PoolClient, 'query'>;

export const MAX_CAPTURE_BYTES = 524288;

const REQUIRED_INITIATOR_CAPABILITIES = ['internal.read', 'run.start'] as const;
const WORK_SCOPES: ReportingCapability[] = REPORTING_CAPABILITIES.filter((capability) => capability !== 'report.summary');
const SUMMARY_SCOPES: ReportingCapability[] = ['report.summary'];
const CREDENTIAL_PATTERN = /^ffcl_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const ACQUIRED_AT_KEY = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

const bootstrapSchema = z.object({
  orgId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(200),
  runnerSessionId: z.number().int().positive(),
  claimId: z.number().int().positive(),
  agentTokenId: z.number().int().positive(),
}).strict();

const contextSchema = z.object({
  claimId: z.number().int().positive(),
  reportingBindingId: z.string().uuid(),
}).strict();

const captureProofSchema = z.object({
  version: z.literal(1),
  bindingId: z.string().uuid(),
  captureId: z.string().uuid(),
  mime: z.string().min(3).max(200),
  sizeBytes: z.number().int().min(0).max(MAX_CAPTURE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentBase64: z.string().max(Math.ceil(MAX_CAPTURE_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  hmac: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

const workspaceProofSchema = z.object({
  version: z.literal(1),
  bindingId: z.string().uuid(),
  seq: z.string().regex(/^[1-9]\d{0,18}$/).refine((value) => value.length < 19 || value <= '9223372036854775807'),
  state: z.enum(['known', 'not_repository', 'unavailable']),
  headCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  dirty: z.boolean().nullable(),
  final: z.boolean(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200).nullable(),
  taskBranch: z.string().min(1).max(1024).regex(/^[^\u0000-\u0020\u007f]+$/).nullable(),
  taskBranchHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  hmac: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict().superRefine((value, context) => {
  if (value.state === 'known' ? value.headCommit === null || value.dirty === null : value.headCommit !== null || value.dirty !== null) {
    context.addIssue({ code: 'custom', message: 'Invalid workspace observation' });
  }
  if ((value.taskBranch === null) !== (value.taskBranchHead === null)
    || (value.state !== 'known' && (value.repository !== null || value.taskBranch !== null || value.taskBranchHead !== null))) {
    context.addIssue({ code: 'custom', message: 'Invalid remote workspace observation' });
  }
});

export type ClaimReportingBinding = {
  bindingId: string;
  credential: string;
  captureKey: string;
};

export type ClaimEvidenceAuthority = {
  orgId: string;
  projectId: string;
  taskId: string;
  claimId: number;
  authorId: string;
  capabilities: ReportingCapability[];
};

export type VerifiedClaimCapture = {
  captureId: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  content: Buffer;
};

type AcquisitionIdentity = {
  bindingId: string;
  claimId: number;
  acquiredAtKey: string;
  runnerSessionId: number;
};

type LiveBindingRow = {
  id: string;
  token_hash: string;
  token_prefix: string;
  principal_id: string;
  org_id: string;
  project_id: string;
  task_id: string;
  claim_id: number;
  runner_session_id: number;
  claim_type: string;
  acquired_at_key: string;
};

function forbidden(): CollabServiceError {
  return new CollabServiceError(403, 'forbidden', 'You do not have permission to perform this action.');
}

function unauthenticated(): CollabServiceError {
  return new CollabServiceError(401, 'unauthenticated', 'Authentication required.');
}

function scopesForClaimType(claimType: string): ReportingCapability[] {
  return claimType === 'summary' ? SUMMARY_SCOPES : WORK_SCOPES;
}

function deriveAcquisitionSecret(secret: string, domain: string, identity: AcquisitionIdentity): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify([domain, identity.bindingId, identity.claimId, identity.acquiredAtKey, identity.runnerSessionId]))
    .digest('base64url');
}

function deriveClaimCredential(secret: string, identity: AcquisitionIdentity): string {
  return `ffcl_${identity.bindingId}_${deriveAcquisitionSecret(secret, 'fluent-flow:claim-reporting:v1', identity)}`;
}

function deriveClaimCaptureKey(secret: string, identity: AcquisitionIdentity): string {
  return deriveAcquisitionSecret(secret, 'fluent-flow:claim-capture:v1', identity);
}

function identityOf(row: LiveBindingRow): AcquisitionIdentity {
  return { bindingId: row.id, claimId: row.claim_id, acquiredAtKey: row.acquired_at_key, runnerSessionId: row.runner_session_id };
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function hasInitiatorAuthority(executor: Executor, principalId: string, projectId: string): Promise<boolean> {
  const capabilities = await getProjectCapabilities(principalId, projectId, executor);
  return REQUIRED_INITIATOR_CAPABILITIES.every((capability) => capabilities.has(capability));
}

async function loadLiveBinding(executor: Executor, bindingId: string, status: 'claimed' | 'completed' = 'claimed'): Promise<LiveBindingRow | null> {
  const result = await executor.query<LiveBindingRow>(
    `SELECT token.id, token.token_hash, token.token_prefix, token.principal_id, token.project_id, token.task_id,
       token.claim_id, token.runner_session_id, claim.claim_type, claim.org_id,
       to_char(token.claimed_at AT TIME ZONE 'UTC', ${ACQUIRED_AT_KEY}) AS acquired_at_key
     FROM collab_scoped_tokens token
     JOIN agent_claims claim ON claim.id = token.claim_id
     JOIN agent_sessions runner ON runner.id = token.runner_session_id
     JOIN agent_tokens origin ON origin.id = token.agent_token_id
     JOIN collab_claim_executions execution ON execution.claim_id = token.claim_id
     JOIN collab_tasks task ON task.id = token.task_id
     JOIN collab_projects project ON project.id = token.project_id
     JOIN collab_workspaces workspace ON workspace.id = project.workspace_id
     JOIN collab_principals principal ON principal.id = token.principal_id
     WHERE token.id = $1
       AND token.revoked_at IS NULL
       AND claim.claimed_at = token.claimed_at
       AND claim.session_id = token.runner_session_id
       AND claim.status = $2
       AND claim.expires_at > NOW()
       AND runner.org_id = claim.org_id
       AND runner.agent_id = origin.agent_id
       AND runner.status <> 'offline'
       AND runner.expires_at > NOW()
       AND origin.org_id = claim.org_id
       AND origin.revoked_at IS NULL
       AND (origin.expires_at IS NULL OR origin.expires_at > NOW())
       AND execution.task_id = token.task_id
       AND execution.project_id = token.project_id
       AND execution.created_by_principal_id = token.principal_id
       AND execution.created_by_session_version = token.creator_session_version
       AND task.project_id = token.project_id
       AND workspace.org_id = claim.org_id
       AND principal.disabled_at IS NULL
       AND principal.session_version = token.creator_session_version`,
    [bindingId, status],
  );
  return result.rows[0] ?? null;
}

async function requireBindingForClaim(executor: Executor, claimId: number, reportingBindingId: string): Promise<void> {
  const result = await executor.query(
    'SELECT id FROM collab_scoped_tokens WHERE id = $1 AND claim_id = $2',
    [reportingBindingId, claimId],
  );
  if (result.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
}

async function requireLiveAuthority(executor: Executor, claimId: number, reportingBindingId: string, lockBinding = false, status: 'claimed' | 'completed' = 'claimed'): Promise<LiveBindingRow> {
  await requireBindingForClaim(executor, claimId, reportingBindingId);
  await executor.query('SELECT id FROM agent_claims WHERE id = $1 FOR SHARE', [claimId]);
  if (lockBinding) await executor.query('SELECT id FROM collab_scoped_tokens WHERE id=$1 FOR UPDATE', [reportingBindingId]);
  const live = await loadLiveBinding(executor, reportingBindingId, status);
  if (live === null || live.claim_id !== claimId) throw forbidden();
  if (!(await hasInitiatorAuthority(executor, live.principal_id, live.project_id))) throw forbidden();
  return live;
}


function contextFor(row: LiveBindingRow): ClaimReportingContext {
  return {
    kind: 'agent',
    projectId: row.project_id,
    taskId: row.task_id,
    capabilities: scopesForClaimType(row.claim_type),
    tokenPrefix: row.token_prefix,
    source: { kind: 'claim', claimId: row.claim_id, reportingBindingId: row.id },
  };
}

export async function ensureClaimReportingBinding(
  tx: Executor,
  input: z.input<typeof bootstrapSchema>,
): Promise<ClaimReportingBinding> {
  const parsed = bootstrapSchema.parse(input);
  const secret = reportingServerKey();
  const claim = await tx.query<{ claim_type: string; session_id: number | null; live: boolean; acquired_at_key: string | null }>(
    `SELECT claim_type, session_id, (status = 'claimed' AND expires_at > NOW()) AS live,
       to_char(claimed_at AT TIME ZONE 'UTC', ${ACQUIRED_AT_KEY}) AS acquired_at_key
     FROM agent_claims WHERE id = $1 AND org_id = $2
     FOR UPDATE`,
    [parsed.claimId, parsed.orgId],
  );
  if (claim.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
  const acquisition = claim.rows[0];
  if (!acquisition.live || acquisition.session_id !== parsed.runnerSessionId || acquisition.acquired_at_key === null) throw forbidden();
  const runner = await tx.query(
    `SELECT id FROM agent_sessions
     WHERE id = $1 AND org_id = $2 AND agent_id = $3 AND status <> 'offline' AND expires_at > NOW()`,
    [parsed.runnerSessionId, parsed.orgId, parsed.agentId],
  );
  if (runner.rows.length === 0) throw forbidden();
  const origin = await tx.query(
    `SELECT id FROM agent_tokens
     WHERE id = $1 AND org_id = $2 AND agent_id = $3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
    [parsed.agentTokenId, parsed.orgId, parsed.agentId],
  );
  if (origin.rows.length === 0) throw forbidden();
  const link = await tx.query<{ task_id: string; project_id: string; created_by_principal_id: string; created_by_session_version: number | null }>(
    `SELECT execution.task_id, execution.project_id, execution.created_by_principal_id, execution.created_by_session_version
     FROM collab_claim_executions execution
     JOIN collab_tasks task ON task.id = execution.task_id AND task.project_id = execution.project_id
     JOIN collab_projects project ON project.id = execution.project_id
     JOIN collab_workspaces workspace ON workspace.id = project.workspace_id
     WHERE execution.claim_id = $1 AND workspace.org_id = $2`,
    [parsed.claimId, parsed.orgId],
  );
  if (link.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
  const origination = link.rows[0];
  if (origination.created_by_session_version === null) throw forbidden();
  const principal = await tx.query(
    'SELECT id FROM collab_principals WHERE id = $1 AND disabled_at IS NULL AND session_version = $2',
    [origination.created_by_principal_id, origination.created_by_session_version],
  );
  if (principal.rows.length === 0) throw forbidden();
  if (!(await hasInitiatorAuthority(tx, origination.created_by_principal_id, origination.project_id))) throw forbidden();
  const existing = await tx.query<{ id: string; revoked_at: Date | null; agent_token_id: number }>(
    `SELECT token.id, token.revoked_at, token.agent_token_id
     FROM collab_scoped_tokens token JOIN agent_claims claim ON claim.id = token.claim_id
     WHERE token.claim_id = $1 AND token.runner_session_id = $2 AND token.claimed_at = claim.claimed_at`,
    [parsed.claimId, parsed.runnerSessionId],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.revoked_at !== null || row.agent_token_id !== parsed.agentTokenId) throw forbidden();
    const identity = { bindingId: row.id, claimId: parsed.claimId, acquiredAtKey: acquisition.acquired_at_key, runnerSessionId: parsed.runnerSessionId };
    return { bindingId: row.id, credential: deriveClaimCredential(secret, identity), captureKey: deriveClaimCaptureKey(secret, identity) };
  }
  const identity = { bindingId: randomUUID(), claimId: parsed.claimId, acquiredAtKey: acquisition.acquired_at_key, runnerSessionId: parsed.runnerSessionId };
  const credential = deriveClaimCredential(secret, identity);
  const inserted = await tx.query(
    `INSERT INTO collab_scoped_tokens
       (id, principal_id, token_hash, token_prefix, scopes, project_id, task_id, claim_id, claimed_at,
        runner_session_id, agent_token_id, creator_session_version)
     SELECT $1, $2, $3, $4, $5, $6, $7, claim.id, claim.claimed_at, $8, $9, $10
     FROM agent_claims claim WHERE claim.id = $11 AND claim.session_id = $8`,
    [
      identity.bindingId,
      origination.created_by_principal_id,
      createHash('sha256').update(credential).digest('hex'),
      credential.slice(0, 12),
      scopesForClaimType(acquisition.claim_type),
      origination.project_id,
      origination.task_id,
      parsed.runnerSessionId,
      parsed.agentTokenId,
      origination.created_by_session_version,
      parsed.claimId,
    ],
  );
  if (inserted.rowCount !== 1) throw forbidden();
  return { bindingId: identity.bindingId, credential, captureKey: deriveClaimCaptureKey(secret, identity) };
}

export async function buildClaimReportingBootstrap(input: z.input<typeof bootstrapSchema>): Promise<ClaimReportingBinding | null> {
  const parsed = bootstrapSchema.parse(input);
  return withClientTransaction(async (tx) => {
    const link = await tx.query<{ created_by_session_version: number | null }>(
      'SELECT created_by_session_version FROM collab_claim_executions WHERE claim_id = $1',
      [parsed.claimId],
    );
    if (link.rows.length === 0 || link.rows[0].created_by_session_version === null) return null;
    return ensureClaimReportingBinding(tx, parsed);
  });
}

export async function resolveClaimReportingContext(
  tx: Executor,
  input: z.input<typeof contextSchema>,
): Promise<ClaimReportingContext> {
  const parsed = contextSchema.parse(input);
  return contextFor(await requireLiveAuthority(tx, parsed.claimId, parsed.reportingBindingId));
}

export async function authenticateClaimReportingToken(token: string): Promise<ClaimReportingContext> {
  const secret = reportingServerKey();
  const match = CREDENTIAL_PATTERN.exec(token);
  if (match === null) throw unauthenticated();
  const live = await loadLiveBinding(getPool(), match[1]);
  if (live === null) throw unauthenticated();
  if (!sameText(token, deriveClaimCredential(secret, identityOf(live)))) throw unauthenticated();
  if (!sameText(createHash('sha256').update(token).digest('hex'), live.token_hash)) throw unauthenticated();
  if (!(await hasInitiatorAuthority(getPool(), live.principal_id, live.project_id))) throw unauthenticated();
  return contextFor(live);
}

export async function resolveClaimEvidenceAuthority(input: {
  taskId: string;
  claimId: number;
  reportingBindingId: string;
}, tx: PoolClient): Promise<ClaimEvidenceAuthority> {
  const live = await requireLiveAuthority(tx, input.claimId, input.reportingBindingId);
  if (live.task_id !== input.taskId) throw forbidden();
  return {
    orgId: live.org_id,
    projectId: live.project_id,
    taskId: live.task_id,
    claimId: live.claim_id,
    authorId: live.principal_id,
    capabilities: scopesForClaimType(live.claim_type),
  };
}

export async function resolveClaimCompletionAuthority(input: {
  taskId: string; claimId: number; reportingBindingId: string;
}, tx: PoolClient): Promise<ClaimEvidenceAuthority> {
  const live = await requireLiveAuthority(tx, input.claimId, input.reportingBindingId, false, 'completed');
  if (live.task_id !== input.taskId) throw forbidden();
  return { orgId: live.org_id, projectId: live.project_id, taskId: live.task_id, claimId: live.claim_id,
    authorId: live.principal_id, capabilities: scopesForClaimType(live.claim_type) };
}

export function normalizedCaptureReference(reference: string | null | undefined): string | null {
  if (typeof reference !== 'string' || reference.length === 0 || reference.length > 2000) return null;
  if (reference.startsWith('/') || reference.includes('\\') || reference.includes('\0')) return null;
  if (reference.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return reference;
}

export function captureProofSigningMaterial(input: {
  bindingId: string;
  claimId: number;
  captureId: string;
  name: string;
  direction: 'input' | 'output';
  reference: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
}): string {
  return JSON.stringify([
    'fluent-flow:file-capture:v1',
    input.bindingId,
    input.claimId,
    input.captureId,
    input.name,
    'file',
    input.direction,
    input.reference,
    input.mime,
    input.sizeBytes,
    input.sha256,
  ]);
}

export async function verifyClaimCaptureProof(input: {
  claimId: number;
  reportingBindingId: string;
  args: {
    name: string;
    direction: 'input' | 'output';
    reference?: string | null;
    content?: string | null;
    mediaType?: string | null;
    sizeBytes?: number | null;
    sha256?: string | null;
  };
  proof: unknown;
}, tx?: Executor): Promise<{ valid: true; capture: VerifiedClaimCapture } | { valid: false; reason: string }> {
  const secret = reportingServerKey();
  const parsed = captureProofSchema.safeParse(input.proof);
  if (!parsed.success) return { valid: false, reason: 'capture_format' };
  const proof = parsed.data;
  if (proof.bindingId !== input.reportingBindingId) return { valid: false, reason: 'capture_binding' };
  const reference = normalizedCaptureReference(input.args.reference);
  if (reference === null) return { valid: false, reason: 'capture_reference' };
  if (input.args.content != null) return { valid: false, reason: 'capture_content' };
  if (input.args.mediaType != null && input.args.mediaType !== proof.mime) return { valid: false, reason: 'capture_mismatch' };
  if (input.args.sizeBytes != null && input.args.sizeBytes !== proof.sizeBytes) return { valid: false, reason: 'capture_mismatch' };
  if (input.args.sha256 != null && input.args.sha256.toLowerCase() !== proof.sha256) return { valid: false, reason: 'capture_mismatch' };
  const content = Buffer.from(proof.contentBase64, 'base64');
  if (content.toString('base64') !== proof.contentBase64 || content.length !== proof.sizeBytes) return { valid: false, reason: 'capture_bytes' };
  if (createHash('sha256').update(content).digest('hex') !== proof.sha256) return { valid: false, reason: 'capture_bytes' };
  const live = await loadLiveBinding(tx ?? getPool(), input.reportingBindingId);
  if (live === null || live.claim_id !== input.claimId) return { valid: false, reason: 'capture_binding' };
  const key = Buffer.from(deriveClaimCaptureKey(secret, identityOf(live)), 'base64url');
  const expected = createHmac('sha256', key)
    .update(captureProofSigningMaterial({
      bindingId: live.id,
      claimId: live.claim_id,
      captureId: proof.captureId,
      name: input.args.name,
      direction: input.args.direction,
      reference,
      mime: proof.mime,
      sizeBytes: proof.sizeBytes,
      sha256: proof.sha256,
    }))
    .digest('base64url');
  if (!sameText(proof.hmac, expected)) return { valid: false, reason: 'capture_signature' };
  return { valid: true, capture: { captureId: proof.captureId, mime: proof.mime, sizeBytes: proof.sizeBytes, sha256: proof.sha256, content } };
}

export async function resolveClaimWorkspaceReport(input: {
  taskId: string;
  claimId: number;
  reportingBindingId: string;
  proof: unknown;
}, tx: PoolClient) {
  const live = await requireLiveAuthority(tx, input.claimId, input.reportingBindingId, true);
  if (live.task_id !== input.taskId || !scopesForClaimType(live.claim_type).includes('report.progress')) throw forbidden();
  const parsed = workspaceProofSchema.safeParse(input.proof);
  const invalid = () => new CollabServiceError(422, 'workspace_proof_invalid', 'Workspace state could not be verified.');
  if (!parsed.success || parsed.data.bindingId !== live.id) throw invalid();
  const proof = parsed.data;
  const material = JSON.stringify(['fluent-flow:workspace-observation:v1', live.id, live.claim_id, proof.seq, proof.state, proof.headCommit, proof.dirty, proof.final, proof.repository, proof.taskBranch, proof.taskBranchHead]);
  const key = Buffer.from(deriveClaimCaptureKey(reportingServerKey(), identityOf(live)), 'base64url');
  const expected = createHmac('sha256', key).update(material).digest('base64url');
  if (!sameText(proof.hmac, expected)) throw invalid();
  return { seq: proof.seq, state: proof.state, headCommit: proof.headCommit, dirty: proof.dirty, final: proof.final,
    repository: proof.repository, taskBranch: proof.taskBranch, taskBranchHead: proof.taskBranchHead,
    proofHash: createHash('sha256').update(material).digest('hex') };
}
