import { z } from 'zod';

const ReviewerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().default('claude-haiku'),
  max_retries: z.number().int().min(0).max(10).default(3),
  diff_limit_kb: z.number().int().min(1).max(512).default(65),
  severity_tiers: z.boolean().default(true),
});

const TransitionRequirementSchema = z.object({
  require: z.array(z.string()).optional(),
  auto: z.boolean().optional(),
  on: z.string().optional(),
});

const PauseConfigSchema = z.object({
  reminder_hours: z.number().int().min(1).default(24),
  reasons: z.array(z.string()).default([
    'decision',
    'ui-review',
    'external-action',
    'agent-stuck',
    'review-escalation',
  ]),
});

const NotificationsConfigSchema = z.object({
  stale_days: z.number().int().min(1).default(3),
  daily_summary: z.boolean().default(true),
  daily_summary_cron: z.string().default('0 12 * * *'),
});

export const DefaultsConfigSchema = z.object({
  reviewer: ReviewerConfigSchema.default({}),
  states: z.array(z.string()).default([
    'Backlog',
    'Ready',
    'In Progress',
    'In Review',
    'Awaiting Human',
    'Done',
    'Cancelled',
  ]),
  transitions: z.record(z.string(), TransitionRequirementSchema).default({}),
  pause: PauseConfigSchema.default({}),
  notifications: NotificationsConfigSchema.default({}),
});

export const RepoConfigSchema = z.object({
  project_id: z.string().optional(),
  agent_id: z.string().optional(),
  reviewer: ReviewerConfigSchema.partial().optional(),
  pause: PauseConfigSchema.partial().optional(),
  notifications: NotificationsConfigSchema.partial().optional(),
});

export const MergedConfigSchema = DefaultsConfigSchema.extend({
  project_id: z.string().optional(),
  agent_id: z.string().optional(),
});

/**
 * Validate and parse the defaults config.
 * @param {unknown} raw
 * @returns {z.infer<typeof DefaultsConfigSchema>}
 */
export function validateDefaults(raw) {
  return DefaultsConfigSchema.parse(raw);
}

/**
 * Validate and parse a repo override config.
 * @param {unknown} raw
 * @returns {z.infer<typeof RepoConfigSchema>}
 */
export function validateRepoConfig(raw) {
  return RepoConfigSchema.parse(raw);
}

/**
 * Validate and parse a merged config.
 * @param {unknown} raw
 * @returns {z.infer<typeof MergedConfigSchema>}
 */
export function validateMergedConfig(raw) {
  return MergedConfigSchema.parse(raw);
}
