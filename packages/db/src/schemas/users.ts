import { z } from 'zod';

export const userSchema = z.object({
  id: z.number(),
  github_id: z.number(),
  login: z.string(),
  email: z.string().nullable(),
  avatar_url: z.string().nullable(),
  is_superadmin: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type User = z.infer<typeof userSchema>;

export const userOrgSchema = z.object({
  user_id: z.number(),
  org_id: z.string(),
  role: z.string().default('member'),
  created_at: z.coerce.date(),
});

export type UserOrg = z.infer<typeof userOrgSchema>;
