import { z } from 'zod';
import { claimTypeSchema } from './repo-config';

export const orgConfigSchema = z.object({
  default_agent: z.string().min(1).optional(),
  claim_types: z.array(claimTypeSchema).min(1).optional(),
  review_model: z.string().min(1).optional(),
  paused: z.boolean().optional(),
});

export type OrgConfig = z.infer<typeof orgConfigSchema>;
