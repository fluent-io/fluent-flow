import { z } from 'zod';

export const sessionSchema = z.object({
  id: z.number(),
  org_id: z.string(),
  agent_id: z.string(),
  session_meta: z.record(z.unknown()).default({}),
  status: z.string().default('online'),
  registered_at: z.coerce.date(),
  last_seen_at: z.coerce.date(),
  expires_at: z.coerce.date(),
});

export type Session = z.infer<typeof sessionSchema>;
