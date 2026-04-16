import { pgTable, text, jsonb, timestamp, integer, index } from 'drizzle-orm/pg-core';

export const auditLog = pgTable('audit_log', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  eventType: text('event_type').notNull(),
  repo: text('repo'),
  actor: text('actor'),
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  createdAtIdx: index('idx_audit_log_created_at').on(t.createdAt),
  eventTypeIdx: index('idx_audit_log_event_type').on(t.eventType),
  repoIdx: index('idx_audit_log_repo').on(t.repo),
}));
