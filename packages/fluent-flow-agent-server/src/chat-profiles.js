import { z } from 'zod';
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const profileSchema = z.object({
  id,
  permission: z.object({ configId: id, value: z.enum(['ask', 'confirm']) }).strict(),
  modelConfigId: id.optional(), models: z.array(id).max(100), defaultModel: id.optional(),
}).strict().superRefine((p, ctx) => {
  if (new Set(p.models).size !== p.models.length || (p.defaultModel != null && !p.models.includes(p.defaultModel)) || (p.models.length > 0 && (!p.modelConfigId || !p.models.includes(p.defaultModel)))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid local model catalog' });
  }
});
export function validateChatProfiles(input) {
  const profiles = z.array(profileSchema).min(1).max(32).parse(input);
  if (Buffer.byteLength(JSON.stringify(profiles), 'utf8') > 64 * 1024) throw new Error('Local chat catalog is too large');
  if (new Set(profiles.map((p) => p.id)).size !== profiles.length) throw new Error('Duplicate local chat profile');
  return profiles;
}
export function resolveChatProfile(profiles, work) {
  for (const key of ['command', 'args', 'env', 'acpCommand', 'acpArgs', 'providerEnvironment']) {
    if (Object.hasOwn(work, key)) throw new Error('Remote process configuration is not permitted');
  }
  const profile = profiles[0];
  if (!profile) throw new Error('Unknown chat profile');
  const model = profile.defaultModel;
  return { ...profile, model };
}

const summaryWorkSchema = z.object({
  requestId: z.string().uuid(),
  profile: id,
  model: id.nullable(),
  prompt: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(300_000),
  reported: z.boolean(),
}).strict();

export function parseSummaryWork(input) {
  return summaryWorkSchema.parse(input);
}

export function resolveSummaryProfile(profiles, summary) {
  const profile = profiles.find((candidate) => candidate.id === summary.profile);
  if (!profile) throw new Error('Unknown summary profile');
  if (summary.model !== null && !profile.models.includes(summary.model)) throw new Error('Unknown summary model');
  return { ...profile, model: summary.model };
}

export function advertisedChatProfiles(profiles) {
  return profiles.map(({ id: profileId, models, defaultModel }) => ({ id: profileId, models: [...models], ...(defaultModel && { default_model: defaultModel }) }));
}
export function assertChatConfigOption(options, configId, value, { current = false } = {}) {
  const option = options?.find((item) => item.configId === configId);
  const values = option?.options?.flatMap((item) => item.options ?? [item]);
  if (option?.type !== 'select' || !values?.some((item) => item.value === value) || (current && option.currentValue !== value)) {
    throw new Error('ACP chat permission/model configuration unavailable');
  }
}
