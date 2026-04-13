import { z } from 'zod';

export const CLAIM_TYPES = ['review', 'fix', 'build', 'spec', 'test'] as const;

export const claimTypeSchema = z.enum(CLAIM_TYPES);
export type ClaimType = z.infer<typeof claimTypeSchema>;

export const repoConfigSchema = z.object({
  default_agent: z.string().min(1),
  claim_types: z.array(claimTypeSchema).min(1),
  review_model: z.string().min(1),
  paused: z.boolean(),
});

export type RepoConfig = z.infer<typeof repoConfigSchema>;
