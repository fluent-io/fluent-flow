import { z } from 'zod';

const OnFailureSchema = z.object({
  model: z.string().optional(),
  thinking: z.enum(['low', 'medium', 'high']).optional(),
});

export const WorkQueueConfigSchema = z
  .object({
    type: z.string().default('github-projects'),
    project_node_id: z.string().optional(),     // Preferred snake_case field
    projectNodeId: z.string().optional(),       // Legacy camelCase — normalized via transform
    failure_state: z.string().optional(),       // Column name for test failure items (default: "Test Failures")
    resolved_state: z.string().optional(),      // Column name for resolved items (default: "Done")
  })
  .transform(({ project_node_id, projectNodeId, ...rest }) => ({
    ...rest,
    project_node_id: project_node_id ?? projectNodeId,
  }));

export const ReviewerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().default('claude-haiku'),
  max_retries: z.number().int().min(0).max(10).default(3),
  diff_limit_kb: z.number().int().min(1).max(512).default(65),
  severity_tiers: z.boolean().default(true),
  on_failure: OnFailureSchema.optional(),
  trigger_check: z.string().optional(),
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
  work_queue: WorkQueueConfigSchema.optional(),
});

const DeliveryConfigSchema = z.object({
  channel: z.string().optional(),
  to: z.string().optional(),
}).optional();

export const RepoConfigSchema = z.object({
  project_id: z.string().optional(),           // single project (backward compat)
  project_ids: z.array(z.string()).optional(),  // multiple projects (preferred)
  agent_id: z.string().optional(),              // legacy — use default_agent
  default_agent: z.string().optional(),          // which registered agent is default for this repo
  reviewer: ReviewerConfigSchema.partial().optional(),
  pause: PauseConfigSchema.partial().optional(),
  notifications: NotificationsConfigSchema.partial().optional(),
  work_queue: WorkQueueConfigSchema.optional(),
  delivery: DeliveryConfigSchema,
});

export const MergedConfigSchema = DefaultsConfigSchema.extend({
  project_id: z.string().optional(),
  project_ids: z.array(z.string()).optional(),
  agent_id: z.string().optional(),
  default_agent: z.string().optional(),
  delivery: DeliveryConfigSchema,
}).transform((config) => {
  // Normalize: merge project_id into project_ids for a single list
  const ids = [...(config.project_ids ?? [])];
  if (config.project_id && !ids.includes(config.project_id)) {
    ids.push(config.project_id);
  }
  // Normalize: agent_id -> default_agent (backward compat)
  const default_agent = config.default_agent ?? config.agent_id ?? undefined;
  return { ...config, project_ids: ids.length > 0 ? ids : undefined, default_agent };
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
