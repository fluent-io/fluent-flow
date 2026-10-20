import { z } from 'zod';

/**
 * Shared wire schemas for the collaboration domain (camelCase). B consumes
 * these from `@fluent-flow/db`; A validates service boundaries with them.
 */
export const taskStatusSchema = z.enum([
  'backlog',
  'ready',
  'in_progress',
  'review',
  'done',
  'cancelled',
]);
export const taskPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const visibilitySchema = z.enum(['client', 'internal']);
export const executionStageSchema = z.enum(['design', 'development', 'test', 'in_review']);
export const runStateSchema = z.enum([
  'queued',
  'launching',
  'running',
  'needs_input',
  'idle',
  'failed',
  'cancel_requested',
  'cancelled',
  'reconciling',
]);
export const hostReachabilitySchema = z.enum(['online', 'stale', 'offline']);

export const collabTaskSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().min(1).max(300),
  description: z.string().max(65535),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  assigneeId: z.string().uuid().nullable(),
  /** Server-side projection of the assignee's display name (null when unassigned). */
  assigneeName: z.string().nullable(),
  version: z.number().int().min(1),
  position: z.string().min(1).max(64),
  blockedReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  execution: z.object({
    latestRun: z.object({ id: z.string().uuid(), state: runStateSchema, stage: executionStageSchema, lastObservedAt: z.string().datetime().nullable() }).nullable(),
    hostReachability: hostReachabilitySchema.nullable(),
    progress: z.string().nullable(),
    attentionCount: z.number().int().min(0),
  }).optional(),
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type Visibility = z.infer<typeof visibilitySchema>;
export type ExecutionStage = z.infer<typeof executionStageSchema>;
export type RunState = z.infer<typeof runStateSchema>;
export type HostReachability = z.infer<typeof hostReachabilitySchema>;
export type CollabTask = z.infer<typeof collabTaskSchema>;
