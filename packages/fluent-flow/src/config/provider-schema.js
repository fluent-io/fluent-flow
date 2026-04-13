import { z } from 'zod';

const CLAIM_TYPES = ['review', 'fix', 'build', 'spec', 'test'];

const ClaimTypeSchema = z.enum(CLAIM_TYPES);

export const RepoConfigSchema = z.object({
  default_agent: z.string().min(1),
  claim_types: z.array(ClaimTypeSchema).min(1),
  review_model: z.string().min(1),
  paused: z.boolean(),
});

export const OrgConfigSchema = z.object({
  default_agent: z.string().min(1).optional(),
  claim_types: z.array(ClaimTypeSchema).min(1).optional(),
  review_model: z.string().min(1).optional(),
  paused: z.boolean().optional(),
});

const InstallationAccountSchema = z.object({
  login: z.string().optional(),
  type: z.string().optional(),
});

const InstallationRefSchema = z.object({
  id: z.number(),
  account: InstallationAccountSchema.optional(),
});

const RepoRefSchema = z.object({
  id: z.number(),
  full_name: z.string(),
});

const InstallationEventSchema = z.object({
  event: z.literal('installation'),
  action: z.enum(['created', 'deleted', 'suspend', 'unsuspend', 'new_permissions_accepted']),
  installation: InstallationRefSchema,
});

const InstallationReposEventSchema = z.object({
  event: z.literal('installation_repositories'),
  action: z.enum(['added', 'removed']),
  installation: InstallationRefSchema,
  repositories_added: z.array(RepoRefSchema).optional(),
  repositories_removed: z.array(RepoRefSchema).optional(),
});

const PullRequestEventSchema = z.object({
  event: z.literal('pull_request'),
  action: z.string(),
  installation: InstallationRefSchema,
  pull_request: z.object({ number: z.number() }).passthrough(),
  repository: RepoRefSchema,
});

export const GitHubWebhookEventSchema = z.discriminatedUnion('event', [
  InstallationEventSchema,
  InstallationReposEventSchema,
  PullRequestEventSchema,
]);
