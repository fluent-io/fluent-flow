import { pgTable, text, jsonb, timestamp, integer, primaryKey, bigint, index, uniqueIndex, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { orgs } from './orgs.js';

export const agents = pgTable('agents', {
  id: text('id').notNull(),
  orgId: text('org_id').notNull().references(() => orgs.id),
  agentType: text('agent_type').notNull(),
  transport: text('transport').notNull(),
  transportMeta: jsonb('transport_meta').default({}),
  repos: text('repos').array().default(sql`ARRAY[]::text[]`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.orgId, t.id] }),
}));

export const agentSessions = pgTable('agent_sessions', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  orgId: text('org_id').notNull().references(() => orgs.id),
  agentId: text('agent_id').notNull(),
  sessionMeta: jsonb('session_meta').default({}),
  status: text('status').default('online'),
  registeredAt: timestamp('registered_at', { withTimezone: true }).defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  agentFk: foreignKey({
    columns: [t.orgId, t.agentId],
    foreignColumns: [agents.orgId, agents.id],
    name: 'agent_sessions_org_id_agent_id_fkey',
  }).onDelete('cascade'),
  activeIdx: index('idx_agent_sessions_active')
    .on(t.orgId, t.agentId, t.status)
    .where(sql`${t.status} = 'online'`),
  // Supports both the periodic expireSessions() UPDATE and every routing query
  // that filters `status <> 'offline' AND expires_at > NOW()`. Partial so the
  // index stays tight (offline rows pile up forever; we never seek them here).
  expiresAtLiveIdx: index('idx_agent_sessions_expires_at_live')
    .on(t.expiresAt)
    .where(sql`${t.status} <> 'offline'`),
}));

export const agentTokens = pgTable('agent_tokens', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  orgId: text('org_id').notNull().references(() => orgs.id),
  agentId: text('agent_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  label: text('label'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => ({
  agentFk: foreignKey({
    columns: [t.orgId, t.agentId],
    foreignColumns: [agents.orgId, agents.id],
    name: 'agent_tokens_org_id_agent_id_fkey',
  }).onDelete('cascade'),
  hashActiveIdx: uniqueIndex('idx_agent_tokens_hash_active')
    .on(t.tokenHash)
    .where(sql`${t.revokedAt} IS NULL`),
  listIdx: index('idx_agent_tokens_list').on(t.orgId, t.agentId, t.createdAt),
  lookupIdx: index('idx_agent_tokens_lookup')
    .on(t.orgId, t.agentId)
    .where(sql`${t.revokedAt} IS NULL`),
}));

export const agentClaims = pgTable('agent_claims', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  orgId: text('org_id').notNull().references(() => orgs.id),
  repo: text('repo').notNull(),
  prNumber: integer('pr_number'),
  attempt: integer('attempt').notNull(),
  sessionId: integer('session_id').references(() => agentSessions.id),
  claimType: text('claim_type').default('review_fix'),
  status: text('status').default('pending'),
  payload: jsonb('payload').default({}),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  checkRunExternalId: bigint('check_run_external_id', { mode: 'number' }),
  headSha: text('head_sha'),
}, (t) => ({
  uniqAttempt: uniqueIndex('agent_claims_org_id_repo_pr_number_attempt_key')
    .on(t.orgId, t.repo, t.prNumber, t.attempt),
  activeIdx: index('idx_agent_claims_active')
    .on(t.orgId, t.repo, t.prNumber)
    .where(sql`${t.status} = ANY (ARRAY['pending', 'claimed'])`),
  // Index for listing claims with NULL pr_number (feature/spec claims)
  activeNoPrIdx: index('idx_agent_claims_active_no_pr')
    .on(t.orgId, t.repo)
    .where(sql`${t.status} = ANY (ARRAY['pending', 'claimed']) AND ${t.prNumber} IS NULL`),
}));
