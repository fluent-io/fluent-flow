import { z } from 'zod';

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
  installation: InstallationSchema.extend({ id: z.number() }),
  repositories_added: z
    .array(z.object({ id: z.number(), full_name: z.string(), private: z.boolean() }))
    .optional(),
  repositories_removed: z
    .array(z.object({ id: z.number(), full_name: z.string(), private: z.boolean() }))
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
  repository: z.object({ id: z.number(), full_name: z.string() }).optional(),
});

export const GitHubWebhookEventSchema = z.discriminatedUnion('event', [
  InstallationEventSchema,
  InstallationRepositoriesEventSchema,
  PullRequestEventSchema,
]);

export type GitHubWebhookEvent = z.infer<typeof GitHubWebhookEventSchema>;
