const BASIC_USER_PREFIX = 'eC1hY2Nlc3MtdG9rZW46';

export function safeError(error) {
  return String(error?.message ?? 'Unknown error')
    .replace(/\b(?:ff|enroll)_[A-Za-z0-9_-]+\b/gu, '[REDACTED]')
    .replace(/\bgh[opusr]_[A-Za-z0-9_]+\b/gu, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/gu, '[REDACTED]')
    .replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=_-]+/giu, '[REDACTED]')
    .replace(new RegExp(`${BASIC_USER_PREFIX}[A-Za-z0-9+/=_-]*`, 'gu'), '[REDACTED]')
    .replace(/(?:CLAUDE_CODE_OAUTH_TOKEN|CODEX_AUTH_JSON)=\S+/gu, '[REDACTED]');
}
