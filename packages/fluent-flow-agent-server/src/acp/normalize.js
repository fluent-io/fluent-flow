import { StringDecoder } from 'node:string_decoder';

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

function markSecretMatches(text, secretValues, mask) {
  for (const secret of secretValues) {
    let index = text.indexOf(secret);
    while (index !== -1) {
      mask.fill(true, index, index + secret.length);
      index = text.indexOf(secret, index + 1);
    }
  }
}

function renderSecretMask(text, mask, redactionOpen = false) {
  let result = '';
  for (let index = 0; index < text.length; index += 1) {
    if (mask[index]) {
      if (!redactionOpen) result += REDACTED;
      redactionOpen = true;
    } else {
      result += text[index];
      redactionOpen = false;
    }
  }
  return { result, redactionOpen };
}

function redactPatterns(text) {
  return text
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;'"`]+/giu, `$1${REDACTED}`)
    .replace(/(\bbearer\s+)[A-Za-z0-9._~+\/-]+/giu, `$1${REDACTED}`)
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passwd|secret|private[_-]?key)\s*[:=]\s*)[^\s,;'"`]+/giu, `$1${REDACTED}`)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu, REDACTED)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9_]{8,}|(?:ff|mcp)_[A-Za-z0-9_-]{16,})\b/gu, REDACTED);
}

function redactText(text, secretValues) {
  if (secretValues.length === 0) return redactPatterns(text);
  const mask = new Array(text.length).fill(false);
  markSecretMatches(text, secretValues, mask);
  return redactPatterns(renderSecretMask(text, mask).result);
}

function decodeBase64Bytes(value) {
  if (typeof value !== 'string') throw new Error('ACP terminal output is invalid');
  const normalized = value.replace(/\s/gu, '');
  if (normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) {
    throw new Error('ACP terminal output is invalid');
  }
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.toString('base64').replace(/=+$/u, '') !== normalized.replace(/=+$/u, '')) {
    throw new Error('ACP terminal output is invalid');
  }
  return bytes;
}

function decodeBase64Text(value) {
  return decodeBase64Bytes(value).toString('utf8');
}

function encodeBase64Text(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function sanitizeTerminalUpdate(update, secretValues) {
  if (update.sessionUpdate === 'terminal_output_chunk' && 'data' in update) {
    return {
      ...update,
      data: encodeBase64Text(redactText(decodeBase64Text(update.data), secretValues)),
    };
  }
  if (
    update.sessionUpdate === 'terminal_update'
    && update.output !== null
    && typeof update.output === 'object'
    && !Array.isArray(update.output)
    && 'data' in update.output
  ) {
    return {
      ...update,
      output: {
        ...update.output,
        data: encodeBase64Text(redactText(decodeBase64Text(update.output.data), secretValues)),
      },
    };
  }
  return update;
}

function textChunk(update, terminalDecoders) {
  if (update === null || typeof update !== 'object' || Array.isArray(update)) return null;
  const sessionUpdate = update.sessionUpdate;
  if (sessionUpdate === 'terminal_output_chunk' && typeof update.terminalId === 'string' && typeof update.data === 'string') {
    const key = `terminal:${update.terminalId}`;
    const write = (text) => ({ ...update, data: encodeBase64Text(text) });
    const state = terminalDecoders.get(key) ?? { decoder: new StringDecoder('utf8'), write };
    state.write = write;
    terminalDecoders.set(key, state);
    return {
      key,
      text: state.decoder.write(decodeBase64Bytes(update.data)),
      write,
    };
  }
  if (
    ['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'session_message_chunk', 'compaction_summary_chunk']
      .includes(sessionUpdate)
    && update.content !== null
    && typeof update.content === 'object'
    && !Array.isArray(update.content)
    && typeof update.content.text === 'string'
  ) {
    const descriptor = ENTITY_FIELDS.get(sessionUpdate);
    const identity = descriptor && typeof update[descriptor[1]] === 'string' ? update[descriptor[1]] : '';
    return {
      key: `${sessionUpdate}:${identity}`,
      text: update.content.text,
      write: (text) => ({ ...update, content: { ...update.content, text } }),
    };
  }
  if (
    sessionUpdate === 'tool_call_content_chunk'
    && typeof update.toolCallId === 'string'
    && update.content !== null
    && typeof update.content === 'object'
    && !Array.isArray(update.content)
    && update.content.content !== null
    && typeof update.content.content === 'object'
    && !Array.isArray(update.content.content)
    && typeof update.content.content.text === 'string'
  ) {
    return {
      key: `tool_call_content_chunk:${update.toolCallId}`,
      text: update.content.content.text,
      write: (text) => ({
        ...update,
        content: { ...update.content, content: { ...update.content.content, text } },
      }),
    };
  }
  return null;
}

function retainedSecretPrefixLength(text, secretValues) {
  let retained = 0;
  for (const secret of secretValues) {
    const maximum = Math.min(secret.length - 1, text.length);
    for (let length = maximum; length > retained; length -= 1) {
      if (text.endsWith(secret.slice(0, length))) {
        retained = length;
        break;
      }
    }
  }
  return retained;
}

const PATTERN_SECRET_TAILS = [
  /(?:^|[^A-Za-z0-9_])(authorization\s*[:=]\s*(?:(?:bearer|basic)\s*)?|bearer\s+)[^\s,;'"`]*$/iu,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passwd|secret|private[_-]?key)\s*[:=]\s*[^\s,;'"`]*$/iu,
  /\b(?:sk-|gh[opusr]_|(?:ff|mcp)_)[A-Za-z0-9_-]*$/u,
];

const PATTERN_SECRET_PREFIXES = [
  'authorization',
  'bearer',
  'api_key',
  'api-key',
  'apikey',
  'access_token',
  'access-token',
  'accesstoken',
  'refresh_token',
  'refresh-token',
  'refreshtoken',
  'id_token',
  'id-token',
  'idtoken',
  'client_secret',
  'client-secret',
  'clientsecret',
  'password',
  'passwd',
  'secret',
  'private_key',
  'private-key',
  'privatekey',
  'sk-',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'ff_',
  'mcp_',
];

function retainedPatternSecretStart(text) {
  let start = text.length;
  for (const pattern of PATTERN_SECRET_TAILS) {
    const match = pattern.exec(text);
    if (match) {
      const leading = match[0].length - match[0].trimStart().length;
      start = Math.min(start, match.index + leading);
    }
  }
  let suffixStart = text.length;
  while (suffixStart > 0) {
    const code = text.charCodeAt(suffixStart - 1);
    const matches = (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || code === 45
      || code === 95;
    if (!matches) break;
    suffixStart -= 1;
  }
  if (suffixStart < text.length) {
    const value = text.slice(suffixStart).toLowerCase();
    if (PATTERN_SECRET_PREFIXES.some((prefix) => prefix.startsWith(value))) {
      start = Math.min(start, suffixStart);
    }
  }
  return start;
}

export function createAcpStreamRedactor(secretValues = []) {
  const liveSecrets = [...new Set(secretValues.filter((value) => typeof value === 'string' && value.length > 0))]
    .sort((left, right) => right.length - left.length);
  const terminalDecoders = new Map();
  const pending = new Map();

  function retainSuppressedPrefix(state, text) {
    const combined = `${state.text}${text}`;
    const retained = retainedSecretPrefixLength(combined, liveSecrets);
    state.text = retained > 0 ? combined.slice(-retained) : '';
    state.mask = new Array(retained).fill(true);
  }

  function flushState(key) {
    const state = pending.get(key);
    if (!state) return [];
    pending.delete(key);
    if (state.suppressPattern) return [];

    const rendered = renderSecretMask(state.text, state.mask, state.redactionOpen);
    const patterned = redactPatterns(rendered.result);
    if (patterned !== rendered.result) return patterned.length > 0 ? [state.write(patterned)] : [];

    const incomplete = retainedSecretPrefixLength(state.text, liveSecrets) > 0
      || retainedPatternSecretStart(state.text) === 0;
    if (incomplete) {
      state.mask.fill(true);
      const conservative = renderSecretMask(state.text, state.mask, state.redactionOpen).result;
      return conservative.length > 0 ? [state.write(conservative)] : [];
    }
    return rendered.result.length > 0 ? [state.write(rendered.result)] : [];
  }

  function append(chunk) {
    const output = [];
    const state = pending.get(chunk.key) ?? {
      key: chunk.key,
      text: '',
      mask: [],
      write: chunk.write,
      redactionOpen: false,
      suppressPattern: false,
    };
    state.write = chunk.write;

    let text = chunk.text;
    if (state.suppressPattern) {
      const delimiter = text.search(/[\s,;'"`]/u);
      if (delimiter === -1) {
        retainSuppressedPrefix(state, text);
        pending.set(chunk.key, state);
        return output;
      }
      retainSuppressedPrefix(state, text.slice(0, delimiter));
      state.suppressPattern = false;
      text = text.slice(delimiter);
    }

    state.text += text;
    const previousMaskLength = state.mask.length;
    state.mask.length += text.length;
    state.mask.fill(false, previousMaskLength);
    markSecretMatches(state.text, liveSecrets, state.mask);
    const exactRetained = retainedSecretPrefixLength(state.text, liveSecrets);
    const patternStart = retainedPatternSecretStart(state.text);
    const boundary = Math.min(state.text.length - exactRetained, patternStart);
    const tailLength = state.text.length - patternStart;

    if (patternStart < state.text.length && tailLength > 256) {
      const rendered = renderSecretMask(
        state.text.slice(0, patternStart),
        state.mask.slice(0, patternStart),
        state.redactionOpen,
      );
      const safe = redactPatterns(rendered.result);
      const textToEmit = rendered.redactionOpen ? safe : `${safe}${REDACTED}`;
      if (textToEmit.length > 0) output.push(state.write(textToEmit));
      retainSuppressedPrefix(state, '');
      state.redactionOpen = true;
      state.suppressPattern = true;
      pending.set(chunk.key, state);
      return output;
    }

    const rendered = renderSecretMask(
      state.text.slice(0, boundary),
      state.mask.slice(0, boundary),
      state.redactionOpen,
    );
    const textToEmit = redactPatterns(rendered.result);
    state.text = state.text.slice(boundary);
    state.mask = state.mask.slice(boundary);
    state.redactionOpen = rendered.redactionOpen;
    if (textToEmit.length > 0) output.push(state.write(textToEmit));
    if (state.text.length > 0 || state.suppressPattern || state.redactionOpen) pending.set(chunk.key, state);
    else pending.delete(chunk.key);
    return output;
  }

  function flush() {
    const output = [];
    for (const [key, state] of terminalDecoders) {
      const text = state.decoder.end();
      terminalDecoders.delete(key);
      if (text.length > 0) output.push(...append({ key, text, write: state.write }));
    }
    for (const key of [...pending.keys()]) output.push(...flushState(key));
    return output;
  }

  function push(update) {
    const chunk = textChunk(update, terminalDecoders);
    if (!chunk) return [update];
    return append(chunk);
  }

  return { push, flush };
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

export function redactAcpPayload(value, secretValues = []) {
  const liveSecrets = [...new Set(secretValues.filter((secret) => typeof secret === 'string' && secret.length > 0))]
    .sort((left, right) => right.length - left.length);
  return redactValue(value, liveSecrets, new WeakSet());
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
  claimId = undefined,
  sessionId = undefined,
  seq = undefined,
  update = undefined,
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
  const raw = redactValue(sanitizeTerminalUpdate(update, liveSecrets), liveSecrets, new WeakSet());
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
