
import { isAbsolute } from 'node:path';

export const INHERITED_ENV_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]);

/**
 * @param {{ backend: 'claude-code'|'codex', contextDir: string, parentEnv?: Record<string, string|undefined>, reportingToken?: string, questionsToken?: string }} opts
 * @returns {Record<string, string>}
 */
export function buildNativeEnv({ backend, contextDir, parentEnv = process.env, reportingToken, questionsToken }) {
  if (backend !== 'claude-code' && backend !== 'codex') throw new Error(`unknown native backend: ${backend}`);
  if (typeof contextDir !== 'string' || !isAbsolute(contextDir)) throw new Error('contextDir must be an absolute path');
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = parentEnv[key];
    if (typeof value === 'string') env[key] = value;
  }
  if (backend === 'claude-code') {
    env.CLAUDE_CONFIG_DIR = contextDir;
    env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = '0';
    env.DISABLE_AUTOUPDATER = '1';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1';
  } else {
    env.CODEX_HOME = contextDir;
    if (reportingToken) env.FF_REPORTING_TOKEN = reportingToken;
    if (questionsToken) env.FF_QUESTIONS_TOKEN = questionsToken;
  }
  return env;
}
