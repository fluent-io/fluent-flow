import { z } from 'zod';

export const claimStatusValues = ['pending', 'claimed', 'completed', 'failed', 'cancelled'] as const;
export type ClaimStatus = (typeof claimStatusValues)[number];

export const claimSchema = z.object({
  id: z.number(),
  org_id: z.string(),
  repo: z.string(),
  pr_number: z.number().nullable(),
  attempt: z.number(),
  session_id: z.number().nullable(),
  claim_type: z.string().default('review_fix'),
  status: z.string().default('pending'),
  payload: z.record(z.unknown()).default({}),
  claimed_at: z.coerce.date().nullable(),
  completed_at: z.coerce.date().nullable(),
  archived_at: z.coerce.date().nullable(),
  expires_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
});

export type Claim = z.infer<typeof claimSchema>;
