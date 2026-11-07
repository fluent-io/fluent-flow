import { z } from 'zod';

const ClaimTypeEnum = z.enum(['review', 'review_fix', 'verify', 'triage', 'test_verify']); // test_verify is deprecated; accepted for stored configs.

export const RepoConfigSchema = z.object({
  default_agent: z.string().optional(),
  claim_types: z.array(ClaimTypeEnum).optional(),
  review_model: z.string().optional(),
  paused: z.boolean().optional(),
});

export const OrgConfigSchema = z.object({
  default_review_model: z.string().optional(),
  default_claim_types: z.array(ClaimTypeEnum).optional(),
  default_agent: z.string().optional(),
});

const InstallationSchema = z.object({
  id: z.number(),
  account: z
    .object({
      login: z.string(),
      type: z.string(),
    })
    .optional(),
});

const InstallationEventSchema = z.object({
  event: z.literal('installation'),
  action: z.enum(['created', 'deleted', 'suspend', 'unsuspend']),
  installation: InstallationSchema,
  repositories: z.array(z.unknown()).optional(),
});

const InstallationRepositoriesEventSchema = z.object({
  event: z.literal('installation_repositories'),
  action: z.enum(['added', 'removed']),
  installation: InstallationSchema,
  repositories_added: z
    .array(
      z.object({
        id: z.number(),
        full_name: z.string(),
        private: z.boolean(),
      })
    )
    .optional(),
  repositories_removed: z
    .array(
      z.object({
        id: z.number(),
        full_name: z.string(),
        private: z.boolean(),
      })
    )
    .optional(),
});

const PullRequestEventSchema = z.object({
  event: z.literal('pull_request'),
  action: z.string(),
  installation: z.object({ id: z.number() }).optional(),
  pull_request: z
    .object({
      number: z.number(),
      head: z.object({ sha: z.string() }).optional(),
      body: z.string().nullable().optional(),
    })
    .optional(),
  repository: z
    .object({
      id: z.number(),
      full_name: z.string(),
    })
    .optional(),
});

export const GitHubWebhookEventSchema = z.discriminatedUnion('event', [
  InstallationEventSchema,
  InstallationRepositoriesEventSchema,
  PullRequestEventSchema,
]);
