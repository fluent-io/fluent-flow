import { pgTable, text, jsonb, timestamp, integer, boolean, primaryKey, check, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const orgs = pgTable('orgs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  settings: jsonb('settings').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const users = pgTable('users', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  githubId: integer('github_id').notNull(),
  login: text('login').notNull(),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  isSuperadmin: boolean('is_superadmin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  githubIdKey: uniqueIndex('users_github_id_key').on(t.githubId),
}));

export const userOrgs = pgTable('user_orgs', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull().references(() => orgs.id),
  role: text('role').notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.orgId] }),
  roleCheck: check('user_orgs_role_check', sql`${t.role} = ANY (ARRAY['member', 'admin'])`),
}));
