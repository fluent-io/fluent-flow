import { and, desc, eq, gt, lt, ne, sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { audit } from '../db/client.js';
import logger from '../logger.js';

const { agentSessions, agents, agentClaims } = schema;

const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Register a new session for an agent.
 */
export async function registerSession(orgId, agentId, sessionMeta = {}, ttlMs = DEFAULT_SESSION_TTL_MS) {
  const expiresAt = new Date(Date.now() + ttlMs);
  const [row] = await db
    .insert(agentSessions)
    .values({ orgId, agentId, sessionMeta, expiresAt })
    .returning();
  audit('session_registered', { data: { orgId, agentId, sessionId: row.id } });
  logger.info({ msg: 'Session registered', orgId, agentId, sessionId: row.id });
  return row;
}

/**
 * Touch a session — refresh last_seen_at and extend expiry.
 */
export async function touchSession(orgId, agentId, sessionId, ttlMs = DEFAULT_SESSION_TTL_MS) {
  const expiresAt = new Date(Date.now() + ttlMs);
  const result = await db
    .update(agentSessions)
    .set({ lastSeenAt: sql`NOW()`, expiresAt })
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.orgId, orgId),
        eq(agentSessions.agentId, agentId),
        ne(agentSessions.status, 'offline'),
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Expire all sessions past their TTL.
 */
export async function expireSessions() {
  const rows = await db
    .update(agentSessions)
    .set({ status: 'offline' })
    .where(and(ne(agentSessions.status, 'offline'), lt(agentSessions.expiresAt, sql`NOW()`)))
    .returning({ id: agentSessions.id, org_id: agentSessions.orgId, agent_id: agentSessions.agentId });
  if (rows.length > 0) logger.info({ msg: 'Sessions expired', count: rows.length });
  return rows;
}

/**
 * Get active (online) sessions for an agent.
 */
export async function getActiveSessions(orgId, agentId) {
  return db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.orgId, orgId),
        eq(agentSessions.agentId, agentId),
        eq(agentSessions.status, 'online'),
        gt(agentSessions.expiresAt, sql`NOW()`),
      ),
    )
    .orderBy(desc(agentSessions.lastSeenAt));
}

/**
 * Resolve the best session for a claim.
 * Priority: previous session for this PR → first available online session → null.
 */
export async function resolveSession(orgId, agentId, repo, prNumber) {
  try {
    const [prev] = await db
      .select({ sessionId: agentClaims.sessionId })
      .from(agentClaims)
      .where(
        and(
          eq(agentClaims.orgId, orgId),
          eq(agentClaims.repo, repo),
          eq(agentClaims.prNumber, prNumber),
          sql`${agentClaims.status} IN ('completed', 'expired')`,
        ),
      )
      .orderBy(desc(agentClaims.attempt))
      .limit(1);
    if (prev?.sessionId) {
      const [check] = await db
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.id, prev.sessionId),
            eq(agentSessions.status, 'online'),
            gt(agentSessions.expiresAt, sql`NOW()`),
          ),
        )
        .limit(1);
      if (check) return check.id;
    }
  } catch (err) {
    if (err?.code !== '42P01') throw err;
  }

  const [avail] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.orgId, orgId),
        eq(agentSessions.agentId, agentId),
        eq(agentSessions.status, 'online'),
        gt(agentSessions.expiresAt, sql`NOW()`),
      ),
    )
    .orderBy(desc(agentSessions.lastSeenAt))
    .limit(1);
  return avail?.id ?? null;
}

/**
 * Find any available session across all agents that can handle this repo.
 */
export async function findAvailableSession(orgId, repo, prNumber) {
  try {
    const [prev] = await db
      .select({ sessionId: agentClaims.sessionId })
      .from(agentClaims)
      .where(
        and(
          eq(agentClaims.orgId, orgId),
          eq(agentClaims.repo, repo),
          eq(agentClaims.prNumber, prNumber),
          sql`${agentClaims.status} IN ('completed', 'expired')`,
        ),
      )
      .orderBy(desc(agentClaims.attempt))
      .limit(1);
    if (prev?.sessionId) {
      const [check] = await db
        .select({ id: agentSessions.id, agent_id: agentSessions.agentId })
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.id, prev.sessionId),
            eq(agentSessions.status, 'online'),
            gt(agentSessions.expiresAt, sql`NOW()`),
          ),
        )
        .limit(1);
      if (check) return { agentId: check.agent_id, sessionId: check.id };
    }
  } catch (err) {
    if (err?.code === '42P01') {
      logger.warn({ msg: 'agent_claims table not yet initialized — skipping PR affinity' });
    } else {
      throw err;
    }
  }

  const rows = await db
    .select({ id: agentSessions.id, agent_id: agentSessions.agentId })
    .from(agentSessions)
    .innerJoin(
      agents,
      and(eq(agents.orgId, agentSessions.orgId), eq(agents.id, agentSessions.agentId)),
    )
    .where(
      and(
        eq(agentSessions.orgId, orgId),
        eq(agentSessions.status, 'online'),
        gt(agentSessions.expiresAt, sql`NOW()`),
        sql`(${agents.repos} = '{}' OR ${repo} = ANY(${agents.repos}))`,
      ),
    )
    .orderBy(desc(agentSessions.lastSeenAt))
    .limit(1);
  if (rows[0]) return { agentId: rows[0].agent_id, sessionId: rows[0].id };
  return null;
}

/**
 * Update session status.
 */
export async function setSessionStatus(orgId, agentId, sessionId, status) {
  await db
    .update(agentSessions)
    .set({ status })
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.orgId, orgId),
        eq(agentSessions.agentId, agentId),
      ),
    );
}
