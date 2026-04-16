import { pgTable, text, jsonb, timestamp, integer, bigint, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { orgs } from './orgs.js';

export const repos = pgTable('repos', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => orgs.id),
  repoExternalId: bigint('repo_external_id', { mode: 'number' }),
  repoFullName: text('repo_full_name').notNull(),
  provider: text('provider').notNull().default('github'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // installation_id is INTEGER, but provider_installations.id is BIGINT.
  // Postgres allows the FK (INTEGER → BIGINT widens). Declared in migration 016.
  installationId: integer('installation_id'),
}, (t) => ({
  orgIdIdx: index('idx_repos_org_id').on(t.orgId),
  extIdIdx: index('idx_repos_repo_external_id').on(t.repoExternalId),
}));

export const orgConfig = pgTable('org_config', {
  orgId: text('org_id').primaryKey().references(() => orgs.id),
  defaultReviewModel: text('default_review_model'),
  defaultClaimTypes: jsonb('default_claim_types'),
  defaultAgent: text('default_agent'),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const repoConfigs = pgTable('repo_configs', {
  repoId: text('repo_id').primaryKey(),
  defaultAgent: text('default_agent'),
  claimTypes: jsonb('claim_types'),
  reviewModel: text('review_model'),
  paused: boolean('paused').notNull().default(false),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const repoConfigHistory = pgTable('repo_config_history', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  repoId: text('repo_id').notNull(),
  patch: jsonb('patch').notNull(),
  actor: text('actor'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  repoIdAtIdx: index('idx_repo_config_history_repo_id_at').on(t.repoId, sql`${t.at} DESC`),
}));

export const configCache = pgTable('config_cache', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  repo: text('repo').notNull(),
  config: jsonb('config').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  repoKey: uniqueIndex('config_cache_repo_key').on(t.repo),
}));
