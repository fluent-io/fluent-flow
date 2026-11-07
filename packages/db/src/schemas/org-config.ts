import { z } from 'zod';

const ClaimTypeEnum = z.enum(['review', 'review_fix', 'verify', 'triage', 'test_verify']); // test_verify is deprecated; accepted for stored configs.

export const OrgConfigSchema = z.object({
  default_review_model: z.string().optional(),
  default_claim_types: z.array(ClaimTypeEnum).optional(),
  default_agent: z.string().optional(),
});

export type OrgConfig = z.infer<typeof OrgConfigSchema>;
