import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { LOG_LEVELS } from './logger.js';

const valueFlags = new Map([
  ['--server', 'serverUrl'],
  ['--provider', 'provider'],
  ['--deployment', 'deployment'],
  ['--capacity', 'capacity'],
  ['--enrollment-token', 'enrollmentToken'],
  ['--provider-secret-file', 'providerSecretFile'],
  ['--work-dir', 'workDir'],
  ['--state-dir', 'stateDir'],
  ['--health-host', 'healthHost'],
  ['--health-port', 'healthPort'],
  ['--acp-command', 'acpCommand'],
  ['--chat-profiles-file', 'chatProfilesFile'],
  ['--execution-timeout-minutes', 'executionTimeoutMs'],
]);

const MS_PER_MINUTE = 60_000;

const noNulString = z.string().min(1).refine((value) => !value.includes('\0'));
const integerText = z.string().regex(/^[0-9]+$/u);
const serverUrlSchema = noNulString.transform((value, context) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid server URL.' });
    return z.NEVER;
  }
  if (url.username || url.password) {
    context.addIssue({ code: 'custom', message: 'Server URL credentials are not allowed.' });
    return z.NEVER;
  }
  if (url.protocol === 'https:') return value;
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'http:' && loopback) return value;
  context.addIssue({ code: 'custom', message: 'Server URL must use HTTPS.' });
  return z.NEVER;
});

const configSchema = z.object({
  serverUrl: serverUrlSchema,
  provider: z.enum(['claude-code', 'codex']),
  deployment: z.enum(['local', 'self_hosted', 'hosted']),
  capacity: z.number().int().min(1).max(16),
  enrollmentToken: noNulString.nullable(),
  tokenFile: noNulString.nullable(),
  providerSecretFile: noNulString.nullable(),
  workDir: noNulString,
  stateDir: noNulString,
  healthHost: noNulString,
  healthPort: z.number().int().min(1).max(65535),
  acpCommand: noNulString.refine((value) => !/\s/u.test(value)).nullable(),
  acpArgs: z.array(z.string().refine((value) => !value.includes('\0'))),
  chatProfilesFile: noNulString.optional(),
  executionTimeoutMs: z.number().int().min(MS_PER_MINUTE).max(1440 * MS_PER_MINUTE),
  logLevel: z.enum(LOG_LEVELS, { error: 'LOG_LEVEL must be one of trace, debug, info, warn, error, fatal.' }),
}).strict().superRefine((config, context) => {
  if (config.deployment !== 'local' && config.providerSecretFile === null) {
    context.addIssue({ code: 'custom', path: ['providerSecretFile'], message: 'Provider credentials are required for this deployment.' });
  }
});

function parseInteger(value, flag) {
  const parsed = integerText.safeParse(value);
  if (!parsed.success) throw new Error(`${flag} requires an integer value.`);
  return Number(value);
}

export function parseConfig(argv, {
  env = process.env,
  cwd = process.cwd(),
  homeDir = homedir(),
} = {}) {
  if (Object.prototype.hasOwnProperty.call(env, 'FLUENT_FLOW_TOKEN')) {
    throw new Error('Plaintext control-plane token environment variables are not supported.');
  }

  const values = {
    serverUrl: undefined,
    provider: undefined,
    deployment: 'local',
    capacity: 2,
    enrollmentToken: null,
    tokenFile: env.FLUENT_FLOW_TOKEN_FILE ?? null,
    providerSecretFile: null,
    workDir: join(cwd, '.fluent-flow', 'work'),
    stateDir: join(homeDir, '.fluent-flow', 'agent-server'),
    healthHost: '127.0.0.1',
    healthPort: 3860,
    acpCommand: null,
    acpArgs: [],
    executionTimeoutMs: 60 * MS_PER_MINUTE,
    logLevel: env.LOG_LEVEL ?? 'info',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--acp-arg') {
      if (index + 1 >= argv.length) throw new Error('--acp-arg requires a value.');
      values.acpArgs.push(argv[index + 1]);
      index += 1;
      continue;
    }
    const property = valueFlags.get(flag);
    if (!property) throw new Error('Unknown agent server option.');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    if (property === 'capacity' || property === 'healthPort') values[property] = parseInteger(value, flag);
    else if (property === 'executionTimeoutMs') values[property] = parseInteger(value, flag) * MS_PER_MINUTE;
    else values[property] = value;
    index += 1;
  }

  return configSchema.parse(values);
}

export async function loadProviderEnvironment(config, { readFile = fs.readFile } = {}) {
  if (config.deployment === 'local' && config.providerSecretFile === null) return {};
  if (typeof config.providerSecretFile !== 'string' || config.providerSecretFile.length === 0) {
    throw new Error('Provider credential file is required.');
  }

  const contents = await readFile(config.providerSecretFile);
  if (!Buffer.isBuffer(contents)) throw new Error('Provider credential file could not be read securely.');
  if (contents.byteLength > 64 * 1024) throw new Error('Provider credential file is too large.');
  const document = contents.toString('utf8').replace(/(?:\r\n|\n)$/u, '');
  if (document.length === 0) throw new Error('Provider credential file is empty.');

  if (config.provider === 'claude-code') {
    return { CLAUDE_CODE_OAUTH_TOKEN: document };
  }
  if (config.provider === 'codex') {
    let parsed;
    try {
      parsed = JSON.parse(document);
    } catch {
      throw new Error('Codex provider credentials are invalid.');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Codex provider credentials are invalid.');
    }
    return { CODEX_AUTH_JSON: document };
  }
  throw new Error('Unsupported provider.');
}
