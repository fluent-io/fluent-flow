import { z } from 'zod';

const installationAccountSchema = z.object({
  login: z.string().optional(),
  type: z.string().optional(),
});

const installationRefSchema = z.object({
  id: z.number(),
  account: installationAccountSchema.optional(),
});

const repoRefSchema = z.object({
  id: z.number(),
  full_name: z.string(),
});

const installationEventSchema = z.object({
  event: z.literal('installation'),
  action: z.enum([
    'created',
    'deleted',
    'suspend',
    'unsuspend',
    'new_permissions_accepted',
  ]),
  installation: installationRefSchema,
});

const installationReposEventSchema = z.object({
  event: z.literal('installation_repositories'),
  action: z.enum(['added', 'removed']),
  installation: installationRefSchema,
  repositories_added: z.array(repoRefSchema).optional(),
  repositories_removed: z.array(repoRefSchema).optional(),
});

const pullRequestEventSchema = z.object({
  event: z.literal('pull_request'),
  action: z.string(),
  installation: installationRefSchema,
  pull_request: z.object({ number: z.number() }).passthrough(),
  repository: repoRefSchema,
});

export const gitHubWebhookEventSchema = z.discriminatedUnion('event', [
  installationEventSchema,
  installationReposEventSchema,
  pullRequestEventSchema,
]);

export type GitHubWebhookEvent = z.infer<typeof gitHubWebhookEventSchema>;
