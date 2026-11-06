const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const REDACTED = '[REDACTED]';

const UPDATE_KINDS = new Map([
  ['user_message_chunk', 'user_message'],
  ['user_message', 'user_message'],
  ['agent_message_chunk', 'agent_message'],
  ['agent_message', 'agent_message'],
  ['agent_thought_chunk', 'agent_thought'],
  ['agent_thought', 'agent_thought'],
  ['state_update', 'state'],
  ['tool_call_content_chunk', 'tool_output'],
  ['tool_call_update', 'tool_call'],
  ['terminal_update', 'terminal'],
  ['terminal_output_chunk', 'terminal_output'],
  ['plan_update', 'plan'],
  ['plan_removed', 'plan'],
  ['available_commands_update', 'commands'],
  ['config_option_update', 'config'],
  ['session_info_update', 'session_info'],
  ['usage_update', 'usage'],
  ['notice', 'notice'],
  ['compaction_update', 'compaction'],
  ['compaction_summary_chunk', 'compaction'],
  ['subagent_update', 'session_info'],
  ['session_message', 'agent_message'],
  ['session_message_chunk', 'agent_message'],
]);

const ENTITY_FIELDS = new Map([
  ['user_message_chunk', ['user_message', 'messageId']],
  ['user_message', ['user_message', 'messageId']],
  ['agent_message_chunk', ['agent_message', 'messageId']],
  ['agent_message', ['agent_message', 'messageId']],
  ['agent_thought_chunk', ['agent_thought', 'messageId']],
  ['agent_thought', ['agent_thought', 'messageId']],
  ['tool_call_content_chunk', ['tool_call', 'toolCallId']],
  ['tool_call_update', ['tool_call', 'toolCallId']],
  ['terminal_update', ['terminal', 'terminalId']],
  ['terminal_output_chunk', ['terminal', 'terminalId']],
  ['plan_update', ['plan', 'planId']],
  ['plan_removed', ['plan', 'planId']],
  ['compaction_update', ['compaction', 'compactionId']],
  ['compaction_summary_chunk', ['compaction', 'compactionId']],
  ['subagent_update', ['subagent', 'sessionId']],
  ['session_message', ['session_message', 'messageId']],
  ['session_message_chunk', ['session_message', 'messageId']],
]);

const SECRET_KEY_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'secretkey',
  'privatekey',
  'signingkey',
  'encryptionkey',
  'password',
  'passwd',
  'clientsecret',
  'credential',
  'credentials',
  'cookie',
  'setcookie',
]);

function isSecretKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return SECRET_KEY_NAMES.has(normalized)
    || normalized.endsWith('token')
    || normalized.endsWith('password')
    || normalized.endsWith('secret');
}

function redactText(text, secretValues) {
  let result = text;
  for (const secret of secretValues) result = result.split(secret).join(REDACTED);
  result = result
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+/giu, `$1${REDACTED}`)
    .replace(/(\bbearer\s+)[A-Za-z0-9._~+\/-]+/giu, `$1${REDACTED}`)
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passwd|secret|private[_-]?key)\s*[:=]\s*)[^\s,;]+/giu, `$1${REDACTED}`)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu, REDACTED)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9_]{8,}|(?:ff|mcp)_[A-Za-z0-9_-]{16,})\b/gu, REDACTED);
  return result;
}

function redactValue(value, secretValues, active) {
  if (typeof value === 'string') return redactText(value, secretValues);
  if (value === null || typeof value !== 'object') return value;
  if (active.has(value)) throw new Error('ACP event payload is invalid');

  active.add(value);
  let redacted;
  if (Array.isArray(value)) {
    redacted = value.map((item) => redactValue(item, secretValues, active));
  } else {
    redacted = Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      isSecretKey(key) && item !== null ? REDACTED : redactValue(item, secretValues, active),
    ]));
  }
  active.delete(value);
  return redacted;
}

function entityFor(update) {
  const descriptor = ENTITY_FIELDS.get(update.sessionUpdate);
  if (!descriptor) return null;
  const [type, idField] = descriptor;
  const id = update[idField];
  if (typeof id !== 'string' || id.length === 0) return null;
  return { type, id };
}

function payloadByteLength(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    throw new Error('ACP event payload is invalid');
  }
}

export function normalizeAcpUpdate({
  claimId,
  sessionId,
  seq,
  update,
  secretValues = [],
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1) {
    throw new Error('ACP event payload limit is invalid');
  }
  if (update === null || typeof update !== 'object' || Array.isArray(update)) {
    throw new Error('ACP event payload is invalid');
  }

  const liveSecrets = [...new Set(secretValues.filter((value) => typeof value === 'string' && value.length > 0))]
    .sort((left, right) => right.length - left.length);
  const raw = redactValue(update, liveSecrets, new WeakSet());
  const payload = { claimId, sessionId, raw };
  const entity = entityFor(raw);
  if (entity) payload.entity = entity;

  if (payloadByteLength(payload) > maxPayloadBytes) {
    throw new Error('ACP event payload is too large');
  }

  return {
    seq,
    kind: UPDATE_KINDS.get(raw.sessionUpdate) ?? 'unknown',
    payload,
  };
}
