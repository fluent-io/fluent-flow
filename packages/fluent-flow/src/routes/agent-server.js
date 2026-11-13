import { Router } from 'express';
import { z } from 'zod';
import { validateToken } from '../agents/token-manager.js';
import { registerSession, touchSession } from '../agents/session-manager.js';
import {
  assertClaimOwner,
  assertClaimReporter,
  cancelClaimById,
  completeClaimById,
  createFollowOnClaim,
  extendClaim,
  failClaimById,
  redispatchClaim,
  withClaimOwner,
} from '../agents/claim-manager.js';
import { dequeue, hasPending } from '../notifications/transports/long-poll.js';
import { sql } from 'drizzle-orm';
import {
  ackClaimCommand,
  cancelClaimRequest,
  appendClaimEvents,
  db,
  exchangeEnrollmentToken,
  getVerificationResultByClaim,
  insertVerificationResultAtomic,
  leaseClaimCommands,
  renewClaimCommand,
  upsertClaimRequest,
  recordClaimWorkspace,
} from '@fluent-flow/db';
import { audit } from '../db/client.js';
import logger from '../logger.js';
import { getInstallationToken, getInstallationCredential } from '../providers/github/token-cache.js';
import { installationCtxForRepo } from '../config/loader.js';
import {
  applyVerifyTransitionOnce,
  handleVerifyRedispatchExhausted,
  VerificationResultSchema,
} from '../engine/verify-transitions.js';
import { onClaimStarted } from '../engine/check-run.js';
import { getProvider } from '../providers/index.js';

const router = Router();
const EnrollmentSchema = z.object({
  instance_id: z.string().uuid(),
});

const ENROLLMENT_ATTEMPT_LIMIT = 10;
const ENROLLMENT_ATTEMPT_WINDOW_MS = 60_000;
const ENROLLMENT_PEER_LIMIT = 1_000;
const enrollmentAttempts = new Map();

function enrollmentAttemptLimited(remoteAddress) {
  const now = Date.now();
  for (const [peer, attempt] of enrollmentAttempts) {
    if (attempt.resetAt <= now) enrollmentAttempts.delete(peer);
  }

  const peer = remoteAddress ?? '';
  let attempt = enrollmentAttempts.get(peer);
  if (!attempt) {
    if (enrollmentAttempts.size >= ENROLLMENT_PEER_LIMIT) {
      enrollmentAttempts.delete(enrollmentAttempts.keys().next().value);
    }
    attempt = { count: 0, resetAt: now + ENROLLMENT_ATTEMPT_WINDOW_MS };
    enrollmentAttempts.set(peer, attempt);
  }

  attempt.count += 1;
  return attempt.count > ENROLLMENT_ATTEMPT_LIMIT;
}
function enrollmentCredential(req) {
  const values = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === 'authorization') {
      values.push(req.rawHeaders[index + 1]);
    }
  }
  if (values.length !== 1) return null;
  return /^Bearer ([^\s]+)$/.exec(values[0])?.[1] ?? null;
}


export async function handleEnrollment(req, res) {
  if (enrollmentAttemptLimited(req.socket.remoteAddress)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const credential = enrollmentCredential(req);
  if (!credential) {
    return res.status(401).json({ error: 'Invalid enrollment credential' });
  }

  const parsed = EnrollmentSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res);

  try {
    const token = await exchangeEnrollmentToken({
      plaintext: credential,
      instanceId: parsed.data.instance_id,
    });
    if (!token) {
      return res.status(401).json({ error: 'Invalid enrollment credential' });
    }
    return res.json({ token: token.plaintext });
  } catch (error) {
    logger.error({
      msg: 'Failed to exchange enrollment credential',
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}


const PollSchema = z.object({
  session_id: z.number().int().positive(),
});

const ClaimResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'cancelled']),
  repo: z.string().min(1).nullable(),
  pr_number: z.number().int().positive().nullable(),
  attempt: z.number().int().positive(),
  verdict: z.enum(['pass', 'fail']).optional(),
  claim_id: z.number().int().positive(),
  session_id: z.number().int().positive(),
  failure_kind: z.enum(['transient', 'terminal']).optional(),
  end_reason: z.enum(['user','idle','no_capacity','max_duration','host_lost']).optional(),
  verification: VerificationResultSchema.optional(),
});

const HeartbeatSchema = z.object({
  session_id: z.number().int().positive(),
  claim_id: z.number().int().positive().optional(),
});

const ClaimPathSchema = z.object({
  claimId: z.coerce.number().int().positive(),
});

const ClaimCommandPathSchema = ClaimPathSchema.extend({
  commandId: z.coerce.number().int().positive(),
});

const ClaimRequestPathSchema = ClaimPathSchema.extend({
  requestKey: z.string().min(1).max(512),
});

const ClaimEventsSchema = z.object({
  session_id: z.number().int().positive(),
  events: z.array(z.object({
    seq: z.number().int().positive(),
    kind: z.enum([
      'user_message',
      'agent_message',
      'agent_thought',
      'state',
      'tool_call',
      'tool_output',
      'terminal',
      'terminal_output',
      'plan',
      'commands',
      'config',
      'session_info',
      'usage',
      'notice',
      'compaction',
      'unknown',
    ]),
    payload: z.record(z.any()),
  })).min(1),
});

const ClaimRequestSchema = z.object({
  session_id: z.number().int().positive(),
  request: z.object({
    requestKey: z.string().min(1).max(512),
    kind: z.enum(['permission', 'elicitation']),
    payload: z.record(z.any()),
  }),
});

const ClaimCommandsPollSchema = z.object({
  session_id: z.number().int().positive(),
});

const ClaimCommandAckSchema = z.object({
  session_id: z.number().int().positive(),
  status: z.enum(['acked', 'failed', 'uncertain']),
  result: z.record(z.any()),
});
const ClaimWorkspaceSchema = z.object({
  session_id: z.number().int().positive(),
  retained: z.boolean(),
  reason: z.enum(['dirty','unpushed','scratch','clean_pushed','inspection_failed','preparation_failed']),
}).strict();

const MAX_EVENT_COUNT = 100;
const MAX_INTERACTION_BYTES = 256 * 1024;
const MAX_EVENT_BATCH_BYTES = 1024 * 1024;
const MAX_ACK_BYTES = 64 * 1024;
const COMMAND_LEASE_LIMIT = 25;

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function validationError(res) {
  return res.status(400).json({ error: 'Validation failed' });
}

function payloadTooLarge(res) {
  return res.status(413).json({ error: 'Payload too large' });
}

function ownershipErrorResponse(error, res) {
  if (error?.statusCode === 404) return res.status(404).json({ error: 'Claim not found' });
  if (error?.statusCode === 409) return res.status(409).json({ error: 'Claim is not active for this runner' });
  return null;
}

/** How far a heartbeat extends a claimed claim's expiry. Env: CLAIM_TTL_MS. */
const CLAIM_TTL_MS = Number(process.env.CLAIM_TTL_MS) || 15 * 60 * 1000;

/**
 * Authenticate agent server requests via agent token.
 */
export async function authenticateAgentServer(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  try {
    const tokenInfo = await validateToken(auth.slice(7));
    if (!tokenInfo) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.tokenInfo = tokenInfo;
    next();
  } catch (err) {
    logger.error({ msg: 'Failed to validate agent server token', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

const KNOWN_SESSION_META_KEYS = new Set([
  'runtime',
  'instance_id',
  'hostname',
  'os',
  'version',
  'provider',
  'deployment',
  'slot_id',
  'capacity',
  'supported_claim_types',
  'profiles',
  'cwd',
]);
const MAX_UNKNOWN_SESSION_META_BYTES = 4096;
const SessionMetaText = z.string().max(256).optional();
const CatalogIdentifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const PublicChatProfiles = z.array(z.object({
  id: CatalogIdentifier,
  models: z.array(CatalogIdentifier).max(100),
  default_model: CatalogIdentifier.optional(),
}).strict().refine((p) => new Set(p.models).size === p.models.length
  && (p.models.length === 0 ? p.default_model === undefined : p.models.includes(p.default_model))))
  .min(1).max(32).refine((profiles) => new Set(profiles.map((p) => p.id)).size === profiles.length
    && serializedBytes(profiles) <= 64 * 1024);
const SessionMetaSchema = z.object({
  runtime: SessionMetaText,
  instance_id: SessionMetaText,
  hostname: SessionMetaText,
  os: SessionMetaText,
  version: SessionMetaText,
  provider: SessionMetaText,
  deployment: SessionMetaText,
  slot_id: z.number().int().min(0).max(1023).optional(),
  capacity: z.number().int().min(1).max(16).optional(),
  supported_claim_types: z.array(z.string().max(64)).max(32).optional(),
  profiles: PublicChatProfiles.optional(),
  cwd: z.string().max(1024).optional(),
}).catchall(z.unknown()).refine(
  (meta) => (
    Object.keys(meta).every((key) => KNOWN_SESSION_META_KEYS.has(key))
    || Buffer.byteLength(JSON.stringify(meta), 'utf8') <= MAX_UNKNOWN_SESSION_META_BYTES
  ),
);

/**
 * POST /api/agent-server/register — register a new session.
 */
export async function handleRegister(req, res) {
  try {
    const { org_id, agent_id } = req.tokenInfo;
    const parsedMeta = SessionMetaSchema.safeParse(req.body?.meta === undefined ? {} : req.body.meta);
    if (!parsedMeta.success) return res.status(400).json({ error: 'Invalid session metadata' });
    const session = await registerSession(org_id, agent_id, parsedMeta.data);
    res.json({ ok: true, session_id: session.id, status: session.status });
  } catch (err) {
    logger.error({ msg: 'Failed to register session', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function claimPendingWork(orgId, agentId, sessionId, ttlMs = 15 * 60 * 1000) {
  const expiresAt = new Date(Date.now() + ttlMs);
  const result = await db.execute(sql`
    WITH live_session AS (
      SELECT session.id, session.session_meta
      FROM agent_sessions session
      WHERE session.id = ${sessionId}
        AND session.org_id = ${orgId}
        AND session.agent_id = ${agentId}
        AND session.status = 'online'
        AND session.expires_at > NOW()
      FOR UPDATE
    ),
    claimed AS (
      UPDATE agent_claims claim SET
        session_id = ${sessionId},
        status = 'claimed',
        claimed_at = NOW(),
        expires_at = ${expiresAt}
      WHERE claim.id = (
        SELECT pending.id
        FROM agent_claims pending
        JOIN agents agent ON agent.org_id = pending.org_id AND agent.id = ${agentId}
        CROSS JOIN live_session
        WHERE pending.org_id = ${orgId}
          AND pending.status = 'pending'
          AND pending.session_id IS NULL
          AND (pending.target_agent_id IS NULL OR pending.target_agent_id = agent.id)
          AND ((pending.claim_type = 'chat' AND pending.repo IS NULL) OR agent.repos = '{}' OR pending.repo = ANY(agent.repos))
          AND CASE WHEN pending.claim_type = 'chat' THEN
            pending.pending_deadline_at > NOW()
            AND chat_slot_available(pending.org_id, agent.id,
              CASE WHEN live_session.session_meta->>'capacity' IN ('1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16')
                THEN (live_session.session_meta->>'capacity')::integer ELSE 1 END)
            ELSE true END
          AND CASE
            WHEN jsonb_typeof(live_session.session_meta->'supported_claim_types') = 'array'
              THEN (live_session.session_meta->'supported_claim_types') ? pending.claim_type
            ELSE pending.claim_type IN ('review', 'review_fix', 'spec', 'build', 'test_verify', 'triage')
          END
        ORDER BY pending.created_at ASC
        LIMIT 1
        FOR UPDATE OF pending SKIP LOCKED
      )
      RETURNING claim.*
    ),
    marked AS (
      UPDATE agent_sessions session
      SET status = 'busy'
      FROM claimed
      WHERE session.id = claimed.session_id
      RETURNING session.id
    )
    SELECT claimed.*
    FROM claimed
    JOIN marked ON marked.id = claimed.session_id
  `);
  const rows = result.rows ?? result;
  return rows[0] ?? null;
}

export async function releaseUndeliveredClaim(orgId, agentId, sessionId, claimId) {
  const result = await db.execute(sql`
    WITH released AS (
      UPDATE agent_claims claim
      SET session_id = NULL,
          status = 'pending',
          claimed_at = NULL,
          expires_at = NULL
      WHERE claim.id = ${claimId}
        AND claim.org_id = ${orgId}
        AND claim.session_id = ${sessionId}
        AND claim.status = 'claimed'
      RETURNING claim.id
    )
    UPDATE agent_sessions session
    SET status = 'online'
    WHERE session.id = ${sessionId}
      AND session.org_id = ${orgId}
      AND session.agent_id = ${agentId}
      AND session.status = 'busy'
      AND session.expires_at > NOW()
      AND EXISTS (SELECT 1 FROM released)
    RETURNING session.id
  `);
  const rows = result.rows ?? result;
  return rows.length > 0;
}

async function resolveGitHubContext(fullRepo) {
  if (!fullRepo?.includes('/')) return null;
  try {
    const [owner, repoName] = fullRepo.split('/');
    return await installationCtxForRepo(owner, repoName);
  } catch (err) {
    logger.warn({ msg: 'Could not resolve GitHub App installation context for agent server', repo: fullRepo, error: err.message, safeToContinue: true });
    return null;
  }
}

async function resolveGitHubToken(fullRepo, context) {
  const ctx = context ?? await resolveGitHubContext(fullRepo);
  if (!ctx?.installation_id) return undefined;
  try {
    const token = await getInstallationToken(ctx.installation_id);
    logger.info({ msg: 'Resolved GitHub App token for agent server', repo: fullRepo, installationId: ctx.installation_id });
    return token;
  } catch (err) {
    logger.warn({ msg: 'Could not resolve GitHub App token for agent server', repo: fullRepo, error: err.message, safeToContinue: true });
    return undefined;
  }
}

/**
 * POST /api/agent-server/poll — long-poll for work.
 */
export async function handlePoll(req, res, opts = {}) {
  const parsed = PollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });

  const { org_id, agent_id } = req.tokenInfo;
  const sessionId = parsed.data.session_id;
  const pollTimeoutMs = opts.pollTimeoutMs ?? 30000;
  let closed = false;
  const onClose = () => {
    if (!res.writableFinished) closed = true;
  };
  res.on('close', onClose);
  if (res.destroyed && !res.writableFinished) closed = true;

  // Resolve the agent's type once for inclusion in work payloads
  let agentType = 'claude-code'; // default
  try {
    const agentRows = await db.execute(sql`SELECT agent_type FROM agents WHERE org_id = ${org_id} AND id = ${agent_id}`);
    if (agentRows.rows?.[0]?.agent_type) agentType = agentRows.rows[0].agent_type;
  } catch {
    // Safe to continue: agent_type lookup failure — fall back to
    // the default 'claude-code'. Non-critical metadata.
  }

  let sent = false;
  const respond = (data) => {
    if (closed || res.destroyed || sent || res.headersSent) return false;
    sent = true;
    res.json(data);
    return true;
  };
  const deliverClaim = async (claim, refreshSession = false) => {
    let delivered = false;
    try {
      if (refreshSession && !(await touchSession(org_id, agent_id, sessionId))) {
        throw new Error('Agent server session expired during claim delivery');
      }
      const payload = typeof claim.payload === 'string' ? JSON.parse(claim.payload) : claim.payload;
      const githubContext = await resolveGitHubContext(claim.repo);
      const credential = claim.claim_type === 'chat' && githubContext?.installation_id
        ? await getInstallationCredential(githubContext.installation_id) : null;
      const githubToken = claim.repo == null ? undefined : claim.claim_type === 'chat'
        ? credential?.token : await resolveGitHubToken(claim.repo, githubContext);
      if (githubContext?.installation_id) {
        try {
          const provider = getProvider({ provider: 'github', installation_id: githubContext.installation_id });
          await onClaimStarted(provider, claim);
        } catch (err) {
          logger.warn({ msg: 'Could not mark claimed check run in progress', claimId: claim.id, error: err.message, safeToContinue: true });
        }
      }
      delivered = respond({
        work: {
          ...payload,
          repo: claim.repo,
          pr_number: claim.pr_number,
          prNumber: claim.pr_number,
          attempt: claim.attempt,
          claim_id: claim.id,
          ...(claim.claim_type === 'chat' ? { task_id: claim.task_id } : {}),
          claim_type: claim.claim_type,
          claimType: claim.claim_type,
          agentType,
          githubToken,
          githubTokenExpiresAt: credential?.expiresAt.toISOString(),
        },
      });
    } finally {
      if (!delivered) {
        await releaseUndeliveredClaim(org_id, agent_id, sessionId, claim.id);
      }
    }
  };

  try {
    const sessionAlive = await touchSession(org_id, agent_id, sessionId);
    if (!sessionAlive) {
      return res.status(410).json({ error: 'Session expired or offline — re-register' });
    }

    // Long-poll hints are wake-up signals only — the dequeued payload lacks
    // attempt/claim_type/message and cannot be reported back by the runner.
    // Drain the hint and let claimPendingWork() hand out the real DB row.
    if (hasPending(sessionId)) {
      dequeue(sessionId);
    }

    // Check for unassigned pending claims in the DB
    const pendingClaim = await claimPendingWork(org_id, agent_id, sessionId);
    if (pendingClaim) {
      await deliverClaim(pendingClaim);
      return;
    }

    if (pollTimeoutMs === 0) {
      respond({ work: null });
      return;
    }

    const start = Date.now();
    while (!closed && !sent) {
      if (hasPending(sessionId)) {
        dequeue(sessionId); // wake-up signal only — claim from the DB below
      }
      const loopClaim = await claimPendingWork(org_id, agent_id, sessionId);
      if (loopClaim) {
        await deliverClaim(loopClaim, true);
        return;
      }
      if (Date.now() - start >= pollTimeoutMs) {
        await touchSession(org_id, agent_id, sessionId);
        respond({ work: null });
        return;
      }
      await sleep(1000);
      if (closed) return;
    }
  } catch (err) {
    logger.error({ msg: 'Failed to poll', error: err.message });
    if (!closed && !res.destroyed && !sent && !res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  } finally {
    res.off('close', onClose);
  }
}

/**
 * POST /api/agent-server/claim — report claim result.
 */
export async function handleClaimResult(req, res) {
  const parsed = ClaimResultSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res);

  try {
    const { org_id, agent_id } = req.tokenInfo;
    const {
      status,
      repo,
      pr_number,
      attempt,
      claim_id: claimId,
      session_id: sessionId,
      failure_kind: failureKind,
      verification,
    } = parsed.data;

    let activeClaim;
    try {
      activeClaim = await assertClaimOwner({ orgId: org_id, agentId: agent_id, sessionId, claimId });
    } catch (error) {
      if ((status === 'cancelled' || status === 'failed') && error?.statusCode === 409) {
        const existing = await assertClaimReporter({ orgId: org_id, agentId: agent_id, sessionId, claimId });
        if (existing.claim_type === 'chat' && existing.status === status && existing.repo === repo && existing.attempt === attempt && pr_number === null) {
          return res.json({ ok: true, claim_id: existing.id, status: existing.status, end_reason: existing.end_reason, note: 'already_resolved' });
        }
      }
      if (status === 'completed' && verification && error?.statusCode === 409) {
        const existing = await assertClaimReporter({ orgId: org_id, agentId: agent_id, sessionId, claimId });
        if (existing?.claim_type === 'verify' && existing.status === 'completed') {
          const stored = await getVerificationResultByClaim(org_id, claimId);
          if (!stored) return res.status(409).json({ error: 'Verification result is unavailable' });
          const storedVerification = {
            phase: stored.phase,
            framework: stored.framework,
            outcome: stored.outcome,
            matrix: stored.matrix,
            manifest: stored.manifest ?? undefined,
            test_hashes: stored.testHashes ?? undefined,
            artifact_sha: stored.artifactSha,
            red_base_sha: stored.redBaseSha,
            green_sha: stored.greenSha,
          };
          await applyVerifyTransitionOnce(existing, storedVerification, { orgId: org_id });
          return res.json({ ok: true, claim_id: existing.id, status: existing.status, note: 'already_resolved' });
        }
      }
      throw error;
    }
    if (activeClaim.claim_type === 'chat' && status === 'completed') return validationError(res);
    if (activeClaim.claim_type !== 'chat' && (repo === null || parsed.data.end_reason !== undefined)) return validationError(res);
    if (activeClaim.claim_type === 'verify' && status === 'completed' && !verification) {
      return validationError(res);
    }
    if (verification && activeClaim.claim_type !== 'verify') {
      return validationError(res);
    }

    const finalize = status === 'completed'
      ? completeClaimById
      : status === 'failed'
        ? failClaimById
        : cancelClaimById;
    const onFinalize = status === 'completed' && verification
      ? async (client, completed) => {
          const inserted = await insertVerificationResultAtomic({
            orgId: org_id,
            claimId: completed.id,
            repo: completed.repo,
            prNumber: completed.pr_number,
            phase: verification.phase,
            framework: verification.framework,
            outcome: verification.outcome,
            matrix: verification.matrix,
            manifest: verification.manifest ?? null,
            testHashes: verification.test_hashes ?? null,
            artifactSha: verification.artifact_sha ?? null,
            redBaseSha: verification.red_base_sha ?? null,
            greenSha: verification.green_sha ?? null,
          }, client);
          if (!inserted) throw new Error('Verification result is already finalized');
          return inserted;
        }
      : null;
    const claim = await finalize(org_id, claimId, sessionId, activeClaim.claim_type === 'chat' ? parsed.data.end_reason ?? (status === 'failed' ? 'host_lost' : 'user') : onFinalize);
    if (!claim) {
      if (activeClaim.claim_type === 'chat' && status === 'cancelled') {
        const existing = await assertClaimReporter({ orgId: org_id, agentId: agent_id, sessionId, claimId });
        if (existing.status === 'cancelled') {
          return res.json({ ok: true, claim_id: existing.id, status: existing.status, end_reason: existing.end_reason, note: 'already_resolved' });
        }
      }
      return res.status(409).json({ error: 'Claim is not active for this runner' });
    }

    if (status === 'cancelled') {
      audit('claim_result', { repo, data: { claimId: claim.id, pr_number, attempt, status } });
      return res.json({ ok: true, claim_id: claim.id, status: claim.status });
    }

    if (status === 'failed') {
      audit('claim_result', {
        repo,
        data: {
          claimId: claim.id,
          pr_number,
          attempt,
          status,
          failure_kind: failureKind ?? 'terminal',
        },
      });
      if (failureKind === 'transient' && claim.claim_type !== 'chat') {
        try {
          const redispatched = await redispatchClaim(claim);
          logger.info({
            msg: 'Re-dispatched transient-failed claim',
            repo,
            prNumber: pr_number,
            oldAttempt: claim.attempt,
            newAttempt: redispatched ? claim.attempt + 1 : null,
            claimId: redispatched?.id ?? null,
          });
          if (!redispatched && claim.claim_type === 'verify') {
            await handleVerifyRedispatchExhausted(claim, { orgId: org_id });
          }
        } catch (err) {
          logger.error({
            msg: 'Failed to re-dispatch transient-failed claim',
            error: err.message,
            claimId: claim.id,
            safeToContinue: true,
          });
        }
      }
      return res.json({ ok: true, claim_id: claim.id, status: claim.status });
    }

    const claimType = claim.claim_type ?? 'review_fix';
    let verdict = parsed.data.verdict;
    if (claimType === 'review' && !verdict && pr_number != null) {
      try {
        const [owner, repoName] = repo.split('/');
        const { fetchLatestReviewVerdict } = await import('../engine/review-manager.js');
        verdict = await fetchLatestReviewVerdict({ owner, repo: repoName, prNumber: pr_number });
        if (verdict) {
          logger.info({ msg: 'Review verdict resolved from GitHub review body', repo, prNumber: pr_number, verdict });
        }
      } catch (err) {
        logger.warn({
          msg: 'Verdict fallback failed',
          repo,
          prNumber: pr_number,
          error: err.message,
          safeToContinue: true,
        });
      }
    }

    audit('claim_result', {
      repo,
      data: { claimId: claim.id, pr_number, attempt, status, claimType, verdict: verdict ?? null },
    });

    if (claimType === 'verify' && verification) {
      await applyVerifyTransitionOnce(claim, verification, { orgId: org_id });
      return res.json({ ok: true, claim_id: claim.id, status: claim.status });
    }

    if (claimType === 'spec' && claim.payload?.auto_chain !== false) {
      try {
        const nextClaim = await createFollowOnClaim({
          parentClaimId: claim.id,
          orgId: org_id,
          repo: claim.repo,
          prNumber: claim.pr_number,
          claimType: 'build',
          payload: { ...(claim.payload?.source === 'collab' ? claim.payload : {}), source_claim_id: claim.id },
          headSha: claim.head_sha,
        });
        if (nextClaim) {
          logger.info({ msg: 'Auto-created build claim after spec completion', repo: claim.repo, prNumber: claim.pr_number, attempt: nextClaim.attempt });
        }
      } catch (err) {
        logger.error({ msg: 'Failed to create follow-on build claim', error: err.message, safeToContinue: true });
      }
    }

    if (claimType === 'test_verify') {
      try {
        const [owner, repoName] = repo.split('/');
        const { dispatchReview } = await import('../engine/review-manager.js');
        const headBranch = claim.payload?.branch ?? 'main';
        const headSha = claim.head_sha;
        const issueNumber = claim.payload?.issueNumber;
        await dispatchReview({ owner, repo: repoName, prNumber: pr_number, ref: headBranch, headSha, attempt: attempt + 1, issueNumber });
        logger.info({ msg: 'Triggered re-review after test_verify completion', repo, prNumber: pr_number, ref: headBranch, headSha });
      } catch (err) {
        logger.error({ msg: 'Failed to trigger re-review after test_verify', error: err.message, safeToContinue: true });
      }
    }

    return res.json({ ok: true, claim_id: claim.id, status: claim.status });
  } catch (err) {
    logger.error({ msg: 'Failed to report claim result', error: err.message });
    const ownershipResponse = ownershipErrorResponse(err, res);
    if (ownershipResponse) return ownershipResponse;
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function interactionErrorResponse(error, res, operation) {
  logger.error({ msg: `Failed to ${operation}`, error: error.message });
  const ownershipResponse = ownershipErrorResponse(error, res);
  if (ownershipResponse) return ownershipResponse;
  if (error.message === 'Claim event payload limit exceeded.') {
    return payloadTooLarge(res);
  }
  if (error.message?.startsWith('Interaction conflict')) {
    return res.status(409).json({ error: 'Interaction conflict' });
  }
  return res.status(500).json({ error: 'Internal server error' });
}

export async function handleClaimEvents(req, res) {
  const path = ClaimPathSchema.safeParse(req.params);
  const body = ClaimEventsSchema.safeParse(req.body);
  if (!path.success || !body.success) return validationError(res);
  if (body.data.events.length > MAX_EVENT_COUNT) return payloadTooLarge(res);
  if (
    serializedBytes(body.data.events) > MAX_EVENT_BATCH_BYTES
    || body.data.events.some((event) => serializedBytes(event.payload) > MAX_INTERACTION_BYTES)
  ) {
    return payloadTooLarge(res);
  }

  const { claimId } = path.data;
  const { session_id: sessionId, events } = body.data;
  const { org_id: orgId, agent_id: agentId } = req.tokenInfo;
  try {
    const result = await withClaimOwner(
      { orgId, agentId, sessionId, claimId },
      (client) => appendClaimEvents({ orgId, claimId, events }, client),
    );
    return res.json({ ok: true, inserted: result.inserted, lastSeq: result.lastSeq });
  } catch (error) {
    return interactionErrorResponse(error, res, 'append claim events');
  }
}

export async function handleClaimRequest(req, res) {
  const path = ClaimPathSchema.safeParse(req.params);
  const body = ClaimRequestSchema.safeParse(req.body);
  if (!path.success || !body.success) return validationError(res);
  if (serializedBytes(body.data.request.payload) > MAX_INTERACTION_BYTES) return payloadTooLarge(res);

  const { claimId } = path.data;
  const { session_id: sessionId, request } = body.data;
  const { org_id: orgId, agent_id: agentId } = req.tokenInfo;
  try {
    const stored = await withClaimOwner(
      { orgId, agentId, sessionId, claimId },
      (client) => upsertClaimRequest({
        orgId,
        claimId,
        requestKey: request.requestKey,
        kind: request.kind,
        payload: request.payload,
      }, client),
    );
    return res.json({
      ok: true,
      request: {
        request_key: stored.requestKey,
        kind: stored.kind,
        payload: stored.payload,
        status: stored.status,
      },
    });
  } catch (error) {
    return interactionErrorResponse(error, res, 'upsert claim request');
  }
}

export async function handleClaimRequestCancellation(req, res) {
  const path = ClaimRequestPathSchema.safeParse(req.params);
  const body = ClaimCommandsPollSchema.safeParse(req.body);
  if (!path.success || !body.success) return validationError(res);

  const { claimId, requestKey } = path.data;
  const { session_id: sessionId } = body.data;
  const { org_id: orgId, agent_id: agentId } = req.tokenInfo;
  try {
    const cancelled = await withClaimOwner(
      { orgId, agentId, sessionId, claimId },
      (client) => cancelClaimRequest({ orgId, claimId, requestKey }, client),
    );
    if (!cancelled) {
      return res.status(409).json({ error: 'Request cancellation conflict' });
    }
    return res.json({ ok: true });
  } catch (error) {
    return interactionErrorResponse(error, res, 'cancel claim request');
  }
}

export async function handleClaimCommandsPoll(req, res) {
  const path = ClaimPathSchema.safeParse(req.params);
  const body = ClaimCommandsPollSchema.safeParse(req.body);
  if (!path.success || !body.success) return validationError(res);

  const { claimId } = path.data;
  const { session_id: sessionId } = body.data;
  const { org_id: orgId, agent_id: agentId } = req.tokenInfo;
  try {
    const commands = await withClaimOwner(
      { orgId, agentId, sessionId, claimId },
      (client) => leaseClaimCommands({ orgId, claimId, limit: COMMAND_LEASE_LIMIT }, client),
    );
    return res.json({
      commands: commands.map((command) => ({
        id: command.id,
        kind: command.kind,
        payload: command.payload,
        request_key: command.requestKey,
      })),
    });
  } catch (error) {
    return interactionErrorResponse(error, res, 'lease claim commands');
  }
}

export async function handleClaimCommandRenewal(req, res) {
  const path = ClaimCommandPathSchema.safeParse(req.params);
  const body = ClaimCommandsPollSchema.safeParse(req.body);
  if (!path.success || !body.success) return validationError(res);

  const { claimId, commandId } = path.data;
  const { session_id: sessionId } = body.data;
  const { org_id: orgId, agent_id: agentId } = req.tokenInfo;
  try {
    const renewed = await withClaimOwner(
      { orgId, agentId, sessionId, claimId },
      (client) => renewClaimCommand({ orgId, claimId, commandId }, client),
    );
    return res.json({ renewed: Boolean(renewed) });
  } catch (error) {
    return interactionErrorResponse(error, res, 'renew claim command');
  }
}

export async function handleClaimCommandAck(req, res) {
  const path = ClaimCommandPathSchema.safeParse(req.params);
  const body = ClaimCommandAckSchema.safeParse(req.body);
  if (!path.success || !body.success) return validationError(res);
  if (serializedBytes(body.data.result) > MAX_ACK_BYTES) return payloadTooLarge(res);

  const { claimId, commandId } = path.data;
  const { session_id: sessionId, status, result } = body.data;
  const { org_id: orgId, agent_id: agentId } = req.tokenInfo;
  try {
    const acknowledged = await withClaimOwner(
      { orgId, agentId, sessionId, claimId },
      (client) => ackClaimCommand({ orgId, claimId, commandId, status, result }, client),
    );
    if (!acknowledged) {
      return res.status(409).json({ error: 'Command acknowledgement conflict' });
    }
    return res.json({ ok: true });
  } catch (error) {
    return interactionErrorResponse(error, res, 'acknowledge claim command');
  }
}

/**
 * POST /api/agent-server/heartbeat — keep a session and its active claim alive
 * while an agent server executes a long agent run. Touches the session (same
 * semantics as the poll touch); when claim_id is present and currently
 * claimed by this session, extends the claim's expires_at by CLAIM_TTL_MS.
 */
export async function handleHeartbeat(req, res) {
  const parsed = HeartbeatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });

  try {
    const { org_id, agent_id } = req.tokenInfo;
    const { session_id: sessionId, claim_id: claimId } = parsed.data;

    const alive = await touchSession(org_id, agent_id, sessionId);
    if (!alive) {
      return res.status(410).json({ error: 'Session expired or offline — re-register' });
    }

    if (claimId != null) {
      const extended = await extendClaim({ orgId: org_id, claimId, sessionId, ttlMs: CLAIM_TTL_MS });
      if (extended) {
        // Audit only actual claim extensions — session-only heartbeats fire
        // every FLUENT_FLOW_HEARTBEAT_MS and would flood the audit log.
        audit('claim_heartbeat', { data: { claimId, sessionId } });
        return res.json({ ok: true, claim: { id: claimId } });
      }
      return res.json({ ok: true, claim: null });
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error({ msg: 'Failed to process agent server heartbeat', error: err.message });
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
}

router.post('/agent-server/enroll', handleEnrollment);
export async function handleClaimWorkspace(req, res) {
  const path = ClaimPathSchema.safeParse(req.params);
  const body = ClaimWorkspaceSchema.safeParse(req.body);
  if (!path.success || !body.success || body.data.retained !== (body.data.reason !== 'clean_pushed')) return validationError(res);
  const { org_id: orgId, agent_id: agentId } = req.tokenInfo;
  const claimId = path.data.claimId;
  const sessionId = body.data.session_id;
  try {
    const claim = await assertClaimReporter({ orgId, agentId, sessionId, claimId });
    if (claim.claim_type !== 'chat') return validationError(res);
    const receipt = await recordClaimWorkspace({ orgId, agentId, sessionId, claimId,
      retained: body.data.retained, reason: body.data.reason });
    if (!receipt) return res.status(409).json({ error: 'Workspace report conflict' });
    return res.json({ ok: true });
  } catch (error) {
    return interactionErrorResponse(error, res, 'report workspace outcome');
  }
}

router.use('/agent-server', authenticateAgentServer);
router.post('/agent-server/register', handleRegister);
router.post('/agent-server/poll', handlePoll);
router.post('/agent-server/heartbeat', handleHeartbeat);
router.post('/agent-server/claim', handleClaimResult);
router.post('/agent-server/claims/:claimId/events', handleClaimEvents);
router.post('/agent-server/claims/:claimId/requests', handleClaimRequest);
router.post('/agent-server/claims/:claimId/requests/:requestKey/cancel', handleClaimRequestCancellation);
router.post('/agent-server/claims/:claimId/commands/poll', handleClaimCommandsPoll);
router.post('/agent-server/claims/:claimId/commands/:commandId/renew', handleClaimCommandRenewal);
router.post('/agent-server/claims/:claimId/commands/:commandId/ack', handleClaimCommandAck);
router.post('/agent-server/claims/:claimId/workspace', handleClaimWorkspace);

export default router;
