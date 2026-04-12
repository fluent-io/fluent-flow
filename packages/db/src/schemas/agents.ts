import { z } from 'zod';

export const agentSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  agent_type: z.string(),
  transport: z.string(),
  transport_meta: z.record(z.unknown()).default({}),
  repos: z.array(z.string()).default([]),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type Agent = z.infer<typeof agentSchema>;

export const agentListItemSchema = agentSchema.extend({
  status: z.string().nullable(),
  last_seen_at: z.coerce.date().nullable(),
});

export type AgentListItem = z.infer<typeof agentListItemSchema>;
