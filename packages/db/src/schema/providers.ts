import { pgTable, text, jsonb, timestamp, bigint, integer, check, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { orgs } from './orgs.js';

export const providerInstallations = pgTable('provider_installations', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  orgId: text('org_id').notNull().references(() => orgs.id),
  provider: text('provider').notNull().default('github'),
  externalInstallationId: bigint('external_installation_id', { mode: 'number' }).notNull(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type').notNull(),
  permissions: jsonb('permissions').notNull().default({}),
  events: jsonb('events').notNull().default([]),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
}, (t) => ({
  providerCheck: check('provider_installations_provider_check', sql`${t.provider} = 'github'`),
  providerExternalKey: uniqueIndex('provider_installations_provider_external_installation_id_key')
    .on(t.provider, t.externalInstallationId),
  orgIdIdx: index('idx_provider_installations_org_id').on(t.orgId),
  externalIdIdx: index('idx_provider_installations_external_id').on(t.externalInstallationId),
}));

export const providerInstallationRepos = pgTable('provider_installation_repos', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  installationId: bigint('installation_id', { mode: 'number' })
    .notNull()
    .references(() => providerInstallations.id, { onDelete: 'cascade' }),
  repoExternalId: bigint('repo_external_id', { mode: 'number' }).notNull(),
  repoFullName: text('repo_full_name').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (t) => ({
  liveIdx: uniqueIndex('idx_provider_installation_repos_live')
    .on(t.installationId, t.repoExternalId)
    .where(sql`${t.removedAt} IS NULL`),
  externalIdx: index('idx_provider_installation_repos_external').on(t.repoExternalId),
  installIdx: index('idx_provider_installation_repos_installation_id').on(t.installationId),
  repoExtIdx: index('idx_provider_installation_repos_repo_external_id').on(t.repoExternalId),
}));

export const providerOutboundQueue = pgTable('provider_outbound_queue', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  installationId: bigint('installation_id', { mode: 'number' })
    .notNull()
    .references(() => providerInstallations.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  clientRef: text('client_ref').notNull(),
  attempts: integer('attempts').notNull().default(0),
  rateLimitedAttempts: integer('rate_limited_attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
  succeededAt: timestamp('succeeded_at', { withTimezone: true }),
  parkedAt: timestamp('parked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kindCheck: check(
    'provider_outbound_queue_kind_check',
    sql`${t.kind} = ANY (ARRAY['comment', 'review', 'create_check_run', 'update_check_run'])`
  ),
  clientRefKey: uniqueIndex('provider_outbound_queue_client_ref_key').on(t.clientRef),
  installIdx: index('idx_outbound_queue_installation_id').on(t.installationId),
  nextAttemptIdx: index('idx_outbound_queue_next_attempt')
    .on(t.nextAttemptAt)
    .where(sql`${t.succeededAt} IS NULL AND ${t.parkedAt} IS NULL`),
  readyIdx: index('idx_provider_outbound_queue_ready')
    .on(t.nextAttemptAt)
    .where(sql`${t.succeededAt} IS NULL AND ${t.parkedAt} IS NULL`),
  installIdx2: index('idx_provider_outbound_queue_installation').on(t.installationId),
}));
