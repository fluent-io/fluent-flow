import { pgTable, text, jsonb, timestamp, integer, varchar, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { agentClaims } from './agents.js';

export const pauses = pgTable('pauses', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  repo: text('repo').notNull(),
  issueNumber: integer('issue_number').notNull(),
  prNumber: integer('pr_number'),
  previousState: text('previous_state').notNull(),
  reason: text('reason').notNull(),
  context: text('context'),
  checklist: jsonb('checklist'),
  resumeTarget: text('resume_target'),
  agentId: text('agent_id'),
  pausedAt: timestamp('paused_at', { withTimezone: true }).defaultNow(),
  resumedAt: timestamp('resumed_at', { withTimezone: true }),
  resumedBy: text('resumed_by'),
  resumeInstructions: text('resume_instructions'),
  resumeToState: text('resume_to_state'),
  resumeAcknowledgedAt: timestamp('resume_acknowledged_at', { withTimezone: true }),
}, (t) => ({
  repoIssueIdx: index('idx_pauses_repo_issue').on(t.repo, t.issueNumber),
}));

export const projectItems = pgTable('project_items', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  projectId: text('project_id').notNull(),
  itemNodeId: text('item_node_id').notNull(),
  repo: text('repo').notNull(),
  issueNumber: integer('issue_number'),
  prNumber: integer('pr_number'),
  currentState: text('current_state').notNull().default('Backlog'),
  assignee: text('assignee'),
  lastActivity: timestamp('last_activity', { withTimezone: true }).defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  projItemKey: uniqueIndex('project_items_project_id_item_node_id_key').on(t.projectId, t.itemNodeId),
  repoIdx: index('idx_project_items_repo').on(t.repo),
}));

export const stateTransitions = pgTable('state_transitions', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  repo: text('repo').notNull(),
  issueNumber: integer('issue_number').notNull(),
  fromState: text('from_state'),
  toState: text('to_state').notNull(),
  triggerType: text('trigger_type').notNull(),
  triggerDetail: text('trigger_detail'),
  actor: text('actor'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  repoIssueIdx: index('idx_state_transitions_repo_issue').on(t.repo, t.issueNumber),
}));

export const reviewRetries = pgTable('review_retries', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  repo: text('repo').notNull(),
  prNumber: integer('pr_number').notNull(),
  retryCount: integer('retry_count').default(0),
  lastIssues: jsonb('last_issues'),
  lastReviewSha: text('last_review_sha'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  lastDispatchSha: text('last_dispatch_sha'),
}, (t) => ({
  repoPrKey: uniqueIndex('review_retries_repo_pr_number_key').on(t.repo, t.prNumber),
}));

export const testFailures = pgTable('test_failures', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  repo: varchar('repo', { length: 255 }).notNull(),
  prNumber: integer('pr_number').notNull(),
  sha: varchar('sha', { length: 40 }),
  retryCount: integer('retry_count').notNull().default(0),
  testOutput: jsonb('test_output'),
  workItemId: varchar('work_item_id', { length: 255 }),
  lastPassSha: varchar('last_pass_sha', { length: 40 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  repoPrKey: uniqueIndex('test_failures_repo_pr_number_key').on(t.repo, t.prNumber),
  createdIdx: index('idx_test_failures_created').on(t.createdAt),
  repoPrIdx: index('idx_test_failures_repo_pr').on(t.repo, t.prNumber),
}));

export const verificationResults = pgTable('verification_results', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  orgId: text('org_id').notNull(),
  claimId: integer('claim_id').notNull().unique().references(() => agentClaims.id, { onDelete: 'cascade' }),
  repo: text('repo').notNull(),
  prNumber: integer('pr_number').notNull(),
  phase: text('phase').notNull(),
  framework: text('framework').notNull(),
  outcome: text('outcome').notNull(),
  matrix: jsonb('matrix'),
  testHashes: jsonb('test_hashes'),
  artifactSha: text('artifact_sha'),
  redBaseSha: text('red_base_sha'),
  greenSha: text('green_sha'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  prIdx: index('idx_verification_results_pr').on(t.orgId, t.repo, t.prNumber),
}));