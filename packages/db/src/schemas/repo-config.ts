import { z } from 'zod';

const ClaimTypeEnum = z.enum(['review', 'review_fix', 'test_verify', 'triage']);

export const RepoConfigSchema = z.object({
  default_agent: z.string().optional(),
  claim_types: z.array(ClaimTypeEnum).optional(),
  review_model: z.string().optional(),
  paused: z.boolean().optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
