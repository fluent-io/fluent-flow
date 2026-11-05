
/**
 * @typedef {{ kind: string, nativeEventId: string, payload?: unknown, terminal?: string, receiptFor?: string }} NativeSpoolEvent
 */

const QUESTION_SERVER = 'ff_questions';
const LOCAL_PLACEHOLDER = '[local answer]';
const MIN_LOCAL_VALUE_LENGTH = 1;
const PRESERVED_PATHS = [
  ['type'], ['phase'], ['state'], ['kind'], ['threadId'], ['turnId'], ['itemId'], ['stream'], ['nativeRequestId'], ['requestId'],
  ['responseId'], ['receiptFor'], ['uuid'], ['fingerprint'], ['method'], ['errorCode'], ['errorKind'], ['commandIds', '*'],
  ['toolUseId'], ['parentToolUseId'],
  ['item', 'type'], ['item', 'id'], ['item', 'server'], ['item', 'tool'], ['item', 'status'], ['item', 'resultWithheld'],
  ['choices', '*', 'id'], ['choices', '*', 'behavior'], ['choices', '*', 'scope'], ['questions', '*', 'id'],
];
const TOOL_USE_PATHS = [['name']];

const CONTENT_MEMBERS = new Set(['arguments', 'result', 'input', 'structuredContent', 'content', '_meta', 'output', 'block', 'error']);
const KEY_COLLISION = 'local_answer_key_collision';

const matches = (rules, path) => rules.some((rule) => rule.length === path.length && rule.every((k, i) => k === '*' ? typeof path[i] === 'number' : k === path[i]));

export function createSpoolPrivacy() {
  const localValues = new Map();

  function replaceValues(text, values) {
    let out = text;
    for (const value of [...values].sort((a, b) => b.length - a.length)) {
      if (out.includes(value)) out = out.split(value).join(LOCAL_PLACEHOLDER);
    }
    return out;
  }

  function stripAnswers(value) {
    if (Array.isArray(value)) return value.map(stripAnswers);
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = stripAnswers(v);
    if (value.type === 'mcpToolCall' && value.server === QUESTION_SERVER && value.result !== null && value.result !== undefined) {
      out.result = null;
      out.resultWithheld = 'ff_question_answer';
    }
    return out;
  }

  function replaceKnown(value, values, preserved, path = [], inContent = false) {
    if (typeof value === 'string') return values.size && !matches(preserved, path) ? replaceValues(value, values) : value;
    if (Array.isArray(value)) return value.map((v, i) => replaceKnown(v, values, preserved, [...path, i], inContent));
    if (value === null || typeof value !== 'object') return value;
    const entries = Object.entries(value);
    const names = entries.map(([k]) => (inContent && values.size ? replaceValues(k, values) : k));
    if (new Set(names).size !== names.length) return { withheld: KEY_COLLISION };
    const out = {};
    entries.forEach(([k, v], i) => {
      const childPath = [...path, k];
      out[names[i]] = replaceKnown(v, values, preserved, childPath, inContent || (CONTENT_MEMBERS.has(k) && !matches(preserved, childPath)));
    });
    return out;
  }

  return {
    registerLocalValue(sessionId, value) {
      if (typeof value !== 'string' || value.length < MIN_LOCAL_VALUE_LENGTH) return;
      if (!localValues.has(sessionId)) localValues.set(sessionId, new Set());
      localValues.get(sessionId).add(value);
    },

    releaseSession(sessionId) {
      localValues.delete(sessionId);
    },

    /**
     * @param {string} sessionId
     * @param {NativeSpoolEvent} event
     * @returns {NativeSpoolEvent} a copy safe to persist
     */
    scrub(sessionId, event) {
      const values = localValues.get(sessionId) ?? new Set();
      const stripped = stripAnswers(event.payload);
      const toolUse = typeof stripped === 'object' && stripped !== null && 'type' in stripped && stripped.type === 'tool_use';
      const preserved = toolUse ? [...PRESERVED_PATHS, ...TOOL_USE_PATHS] : PRESERVED_PATHS;
      return { ...event, payload: replaceKnown(stripped, values, preserved) };
    },
  };
}
