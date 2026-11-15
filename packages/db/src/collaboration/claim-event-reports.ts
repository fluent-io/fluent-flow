import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { resolveClaimReportingContext } from './claim-reporting.js';
import { recordUsageSample, recordWorkpadPlanReport } from './evidence.js';
import { recordAgentProgress } from './tokens.js';
import { CollabServiceError } from './errors.js';

const usagePayload = z.object({
  sessionId: z.string().min(1),
  raw: z.object({
    sessionUpdate: z.literal('usage_update'),
    used: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
  }),
});

const entries = z.array(z.object({ content: z.string().min(1).max(500), status: z.enum(['pending', 'in_progress', 'completed']) })).max(50);
const planPayload = z.object({ raw: z.union([
  z.object({ sessionUpdate: z.literal('plan'), entries }),
  z.object({ sessionUpdate: z.literal('plan_update'), plan: z.object({ entries }) }).transform(({ plan }) => plan),
  z.object({ sessionUpdate: z.literal('plan_removed') }).transform(() => ({ entries: [] })),
]) });
const progressPayload = z.object({ raw: z.union([
  z.object({ sessionUpdate: z.literal('state_update'), progress: z.object({ text: z.string().min(1).max(1000), percent: z.number().min(0).max(100).nullable().default(null) }) }),
  z.object({
    sessionUpdate: z.enum(['tool_call', 'tool_call_update']),
    title: z.string().optional(), name: z.string().optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  }),
]) });
type WorkpadReport = { kind: 'plan'; items: { text: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  | { kind: 'progress'; text: string; percent: number | null };

function workpadReport(event: { kind: string; payload: unknown }): WorkpadReport | null {
  if (event.kind === 'plan') {
    const parsed = planPayload.safeParse(event.payload);
    if (parsed.success) return { kind: 'plan', items: parsed.data.raw.entries.map(entry => ({ text: entry.content, status: entry.status })) };
  }
  if (event.kind === 'state' || event.kind === 'tool_call') {
    const parsed = progressPayload.safeParse(event.payload);
    if (parsed.success) {
      const raw = parsed.data.raw;
      if ('progress' in raw) return { kind: 'progress', ...raw.progress };
      let text = `${raw.title ?? raw.name ?? 'Tool'}: ${raw.status}`.slice(0, 1000);
      if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
      return { kind: 'progress', text, percent: null };
    }
  }
  return null;
}

export async function projectClaimEventReports(input: {
  orgId: string;
  claimId: number;
  runnerSessionId: number;
  agentTokenId: number;
  events: Array<{ seq: number; kind: string; payload: unknown }>;
}, tx: PoolClient): Promise<void> {
  const sessions = new Set<string>();
  const sequences: number[] = [];
  const workpadKinds = new Set<'plan' | 'progress'>();
  for (const event of input.events) {
    const report = workpadReport(event);
    if (report) {
      workpadKinds.add(report.kind);
      sequences.push(event.seq);
    }
    if (event.kind !== 'usage') continue;
    const parsed = usagePayload.safeParse(event.payload);
    if (!parsed.success) continue;
    sessions.add(parsed.data.sessionId);
    sequences.push(event.seq);
  }
  if (sequences.length === 0) return;
  const binding = await tx.query<{ created_by_session_version: number | null; binding_id: string | null; agent_token_id: number | null; principal_id: string }>(
    `SELECT execution.created_by_session_version, token.id AS binding_id, token.agent_token_id, token.principal_id
     FROM collab_claim_executions execution
     JOIN agent_claims claim ON claim.id = execution.claim_id
     LEFT JOIN collab_scoped_tokens token ON token.claim_id = claim.id
       AND token.claimed_at = claim.claimed_at AND token.runner_session_id = claim.session_id
     WHERE claim.id = $1 AND claim.org_id = $2 AND claim.session_id = $3`,
    [input.claimId, input.orgId, input.runnerSessionId],
  );
  const owner = binding.rows[0];
  if (!owner || (owner.created_by_session_version === null && owner.binding_id === null)) return;
  if (owner.binding_id === null) throw new Error('Claim reporting binding is unavailable.');
  if (owner.agent_token_id !== input.agentTokenId) throw new CollabServiceError(403, 'forbidden', 'Access denied.');
  const context = await resolveClaimReportingContext(tx, { claimId: input.claimId, reportingBindingId: owner.binding_id });
  const tagged = await tx.query(
    `UPDATE agent_claim_events SET reporting_binding_id = $4
     WHERE org_id = $1 AND claim_id = $2 AND seq = ANY($3::bigint[])
       AND (reporting_binding_id IS NULL OR reporting_binding_id = $4)`,
    [input.orgId, input.claimId, sequences, owner.binding_id],
  );
  if (tagged.rowCount !== sequences.length) throw new Error('Claim report source does not match its accepted events.');
  if (context.capabilities.includes('report.progress')) {
    for (const kind of workpadKinds) {
      const source = await tx.query<{ seq: string; kind: string; payload: unknown }>(
        `SELECT seq::text AS seq,kind,payload FROM agent_claim_events
         WHERE org_id=$1 AND claim_id=$2 AND reporting_binding_id=$3 AND kind=ANY($4::text[])
         ORDER BY agent_claim_events.seq DESC LIMIT 1`,
        [input.orgId, input.claimId, owner.binding_id, kind === 'plan' ? ['plan'] : ['state', 'tool_call']],
      );
      const latest = source.rows[0];
      const report = latest && workpadReport(latest);
      if (!report || report.kind !== kind) throw new Error('Claim report source is invalid.');
      const scope = `claim-event-${kind}:${owner.binding_id}`;
      const key = `event-seq:${latest.seq}`;
      const hash = createHash('sha256').update(JSON.stringify(report)).digest('hex');
      const previous = await tx.query<{ request_hash: string }>(
        'SELECT request_hash FROM collab_idempotency_records WHERE principal_id=$1 AND scope_key=$2 AND idempotency_key=$3',
        [owner.principal_id, scope, key],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== hash) throw new Error('Claim report source changed after projection.');
        continue;
      }
      let resourceId = context.taskId;
      if (report.kind === 'plan') {
        const plan = await recordWorkpadPlanReport({ taskId: context.taskId, source: context.source, items: report.items }, tx);
        resourceId = plan.id;
      } else {
        await recordAgentProgress(context, { text: report.text, percent: report.percent }, tx);
      }
      await tx.query(
        'INSERT INTO collab_idempotency_records(principal_id,scope_key,idempotency_key,request_hash,resource_id) VALUES($1,$2,$3,$4,$5)',
        [owner.principal_id, scope, key, hash, resourceId],
      );
    }
  }
  if (sessions.size === 0) return;
  const costs = await tx.query<{ session_id: string; seq: string; cost: { amount: number; currency: string } | null }>(
    `SELECT DISTINCT ON (payload->>'sessionId') payload->>'sessionId' AS session_id,
       seq::text AS seq, payload->'raw'->'cost' AS cost
     FROM agent_claim_events
     WHERE org_id = $1 AND claim_id = $2 AND reporting_binding_id = $3 AND kind = 'usage'
       AND payload->>'sessionId' = ANY($4::text[])
       AND (payload->'raw'->'cost' = 'null'::jsonb OR
         (jsonb_typeof(payload->'raw'->'cost'->'amount') = 'number'
          AND jsonb_typeof(payload->'raw'->'cost'->'currency') = 'string'))
     ORDER BY payload->>'sessionId', agent_claim_events.seq DESC`,
    [input.orgId, input.claimId, owner.binding_id, [...sessions]],
  );
  const bySession = new Map<string, typeof costs.rows[number]>();
  for (const row of costs.rows) bySession.set(row.session_id, row);
  for (const sessionId of sessions) {
    const latest = bySession.get(sessionId);
    const cost = latest?.cost;
    const costUsd = cost?.currency === 'USD' && Number.isFinite(cost.amount) ? cost.amount : null;
    await recordUsageSample({
      source: context.source,
      taskId: context.taskId,
      providerTurnId: `acp-session-snapshot:${createHash('sha256').update(sessionId).digest('hex')}`,
      tokensIn: null,
      tokensOut: null,
      costUsd,
      unavailableReason: costUsd !== null ? 'provider_did_not_report_token_usage'
        : cost && cost.currency !== 'USD' ? 'provider_did_not_report_usd_cost' : 'provider_did_not_report_usage',
      sourceEventSeq: latest?.seq ?? '0',
      sampleKind: 'session_snapshot',
    }, tx);
  }
}
