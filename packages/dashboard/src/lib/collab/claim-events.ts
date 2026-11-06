import type { ClaimExecutionEvent } from './types';

const TERMINAL_BYTES = 64 * 1024;
const UNKNOWN_CHARS = 2000;
const TERMINAL_ENCODER = new TextEncoder();
const TERMINAL_DECODER = new TextDecoder('utf-8', { fatal: false });
const EMPTY_BYTES = new Uint8Array();


type RecordValue = Record<string, unknown>;

export interface ClaimEventEntity extends RecordValue {
  key: string;
  type: string;
  id: string;
}

export interface ClaimNotice {
  seq: number;
  severity: string;
  title: string;
  description?: string;
}

export interface ClaimUnknownEvent {
  seq: number;
  name: string;
  text: string;
}

export interface ClaimEventState {
  entities: ClaimEventEntity[];
  notices: ClaimNotice[];
  unknown: ClaimUnknownEvent[];
  runnerState: { state: string; stopReason?: string } | null;
  usage: RecordValue | null;
  commands: RecordValue | null;
  config: RecordValue | null;
  sessionInfo: RecordValue | null;
  lastSeq: number;
}

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function array(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function safeText(value: unknown, max = UNKNOWN_CHARS): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = '[Unserializable payload]';
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string') return EMPTY_BYTES;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return EMPTY_BYTES;
  }
}

function cleanTerminal(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function boundedBytes(value: Uint8Array): { bytes: Uint8Array; truncated: boolean } {
  if (value.byteLength <= TERMINAL_BYTES) return { bytes: value, truncated: false };
  return { bytes: value.slice(value.byteLength - TERMINAL_BYTES), truncated: true };
}

function appendBytes(current: Uint8Array, chunk: Uint8Array): { bytes: Uint8Array; truncated: boolean } {
  if (chunk.byteLength === 0) return { bytes: current, truncated: false };
  const total = current.byteLength + chunk.byteLength;
  const size = Math.min(total, TERMINAL_BYTES);
  const bytes = new Uint8Array(size);
  const chunkStart = Math.max(0, chunk.byteLength - size);
  const chunkSize = chunk.byteLength - chunkStart;
  const currentSize = size - chunkSize;
  if (currentSize > 0) bytes.set(current.subarray(current.byteLength - currentSize));
  bytes.set(chunk.subarray(chunkStart), currentSize);
  return { bytes, truncated: total > TERMINAL_BYTES };
}

function decodeTerminal(value: Uint8Array): string {
  let start = 0;
  while (start < value.byteLength && (value[start] & 0xc0) === 0x80) start += 1;
  const output = cleanTerminal(TERMINAL_DECODER.decode(value.subarray(start)));
  const encoded = TERMINAL_ENCODER.encode(output);
  if (encoded.byteLength <= TERMINAL_BYTES) return output;
  const tail = encoded.subarray(encoded.byteLength - TERMINAL_BYTES);
  let tailStart = 0;
  while (tailStart < tail.byteLength && (tail[tailStart] & 0xc0) === 0x80) tailStart += 1;
  return TERMINAL_DECODER.decode(tail.subarray(tailStart));
}

function entityIdentity(payload: RecordValue, raw: RecordValue, kind: string): { type: string; id: string } | null {
  const supplied = record(payload.entity);
  const suppliedType = string(supplied?.type);
  const suppliedId = string(supplied?.id);
  if (suppliedType && suppliedId) return { type: suppliedType, id: suppliedId };

  const update = string(raw.sessionUpdate) ?? '';
  if (kind === 'plan') {
    const planId = string(record(raw.plan)?.planId) ?? string(raw.planId);
    return { type: 'plan', id: planId ?? 'current' };
  }
  const candidates: Array<[string, unknown]> = [
    ['terminal', raw.terminalId],
    ['tool_call', raw.toolCallId],
    [kind === 'compaction' ? 'compaction' : kind, raw.compactionId],
    [update.startsWith('session_message') ? 'session_message' : kind, raw.messageId],
    ['subagent', raw.sessionId],
  ];
  const found = candidates.find(([, id]) => typeof id === 'string' && id.length > 0);
  return found ? { type: found[0], id: found[1] as string } : null;
}

function upsert(
  entities: ClaimEventEntity[],
  identity: { type: string; id: string },
  update: (current: ClaimEventEntity | undefined) => ClaimEventEntity,
): ClaimEventEntity[] {
  const key = `${identity.type}:${identity.id}`;
  const index = entities.findIndex((entity) => entity.key === key);
  const next = update(index >= 0 ? entities[index] : undefined);
  if (index < 0) return [...entities, next];
  const copy = entities.slice();
  copy[index] = next;
  return copy;
}

function patchNullable(current: ClaimEventEntity, raw: RecordValue, field: string, reset: unknown): void {
  if (!(field in raw)) return;
  current[field] = raw[field] === null ? reset : raw[field];
}

function applyEntity(entities: ClaimEventEntity[], kind: string, raw: RecordValue, payload: RecordValue): ClaimEventEntity[] {
  const identity = entityIdentity(payload, raw, kind);
  if (!identity) return entities;
  const key = `${identity.type}:${identity.id}`;
  const sessionUpdate = string(raw.sessionUpdate) ?? '';

  if (kind === 'agent_message' || kind === 'user_message' || kind === 'agent_thought') {
    return upsert(entities, identity, (existing) => {
      const next: ClaimEventEntity = { key, type: identity.type, id: identity.id, content: [], ...existing };
      if (sessionUpdate.endsWith('_chunk')) {
        if ('content' in raw) next.content = [...(Array.isArray(next.content) ? next.content : []), raw.content];
      } else if ('content' in raw) {
        next.content = raw.content === null ? [] : Array.isArray(raw.content) ? raw.content : [raw.content];
      }
      return next;
    });
  }

  if (kind === 'tool_call' || kind === 'tool_output') {
    return upsert(entities, { type: 'tool_call', id: identity.id }, (existing) => {
      const toolKey = `tool_call:${identity.id}`;
      const next: ClaimEventEntity = { key: toolKey, type: 'tool_call', id: identity.id, kind: 'other', status: 'pending', content: [], ...existing };
      if (sessionUpdate === 'tool_call_content_chunk') {
        if ('content' in raw) next.content = [...(Array.isArray(next.content) ? next.content : []), raw.content];
        return next;
      }
      patchNullable(next, raw, 'name', null);
      patchNullable(next, raw, 'title', null);
      patchNullable(next, raw, 'kind', 'other');
      patchNullable(next, raw, 'status', 'pending');
      patchNullable(next, raw, 'content', []);
      patchNullable(next, raw, 'locations', []);
      patchNullable(next, raw, 'rawInput', null);
      patchNullable(next, raw, 'rawOutput', null);
      patchNullable(next, raw, 'capabilities', []);
      if ('_meta' in raw) {
        if (raw._meta === null) next.meta = {};
        else {
          const meta = { ...(record(next.meta) ?? {}) };
          for (const [metaKey, value] of Object.entries(record(raw._meta) ?? {})) {
            if (value === null) delete meta[metaKey];
            else meta[metaKey] = value;
          }
          next.meta = meta;
        }
      }
      return next;
    });
  }

  if (kind === 'terminal' || kind === 'terminal_output') {
    return upsert(entities, { type: 'terminal', id: identity.id }, (existing) => {
      const next: ClaimEventEntity = { key: `terminal:${identity.id}`, type: 'terminal', id: identity.id, output: '', truncated: false, ...existing };
      let bytes = next.terminalBytes instanceof Uint8Array
        ? next.terminalBytes
        : TERMINAL_ENCODER.encode(typeof next.output === 'string' ? next.output : '');
      let previouslyTruncated = next.truncated === true;
      if (sessionUpdate === 'terminal_update') {
        patchNullable(next, raw, 'command', null);
        patchNullable(next, raw, 'cwd', null);
        patchNullable(next, raw, 'size', null);
        patchNullable(next, raw, 'capabilities', []);
        if ('exitStatus' in raw) next.exitStatus = raw.exitStatus;
        const snapshot = record(raw.output);
        if (snapshot && 'data' in snapshot) {
          const bounded = boundedBytes(decodeBase64(snapshot.data));
          bytes = bounded.bytes;
          previouslyTruncated = bounded.truncated;
        }
      } else if ('data' in raw) {
        const appended = appendBytes(bytes, decodeBase64(raw.data));
        bytes = appended.bytes;
        previouslyTruncated = previouslyTruncated || appended.truncated;
      }
      next.terminalBytes = bytes;
      next.output = decodeTerminal(bytes);
      next.truncated = previouslyTruncated;
      return next;
    });
  }

  if (kind === 'plan') {
    if (sessionUpdate === 'plan_removed') return entities.filter((entity) => entity.key !== key);
    const plan = record(raw.plan);
    const legacyContent = record(raw.content);
    const entries = array(plan?.entries) ?? array(legacyContent?.entries) ?? [];
    return upsert(entities, { type: 'plan', id: identity.id }, (existing) => ({
      key,
      type: 'plan',
      id: identity.id,
      ...existing,
      entries,
    }));
  }

  if (kind === 'compaction') {
    return upsert(entities, identity, (existing) => {
      const next: ClaimEventEntity = { key, type: identity.type, id: identity.id, status: 'in_progress', summary: [], ...existing };
      if (sessionUpdate.endsWith('_chunk')) {
        if ('content' in raw) next.summary = [...(Array.isArray(next.summary) ? next.summary : []), raw.content];
      } else {
        patchNullable(next, raw, 'status', 'in_progress');
        patchNullable(next, raw, 'summary', []);
        patchNullable(next, raw, 'error', null);
      }
      return next;
    });
  }

  return upsert(entities, identity, (existing) => ({ ...existing, ...raw, key, type: identity.type, id: identity.id }));
}

export function createClaimEventState(): ClaimEventState {
  return {
    entities: [],
    notices: [],
    unknown: [],
    runnerState: null,
    usage: null,
    commands: null,
    config: null,
    sessionInfo: null,
    lastSeq: 0,
  };
}

export function reduceClaimEvents(previous: ClaimEventState, events: ClaimExecutionEvent[]): ClaimEventState {
  let state = previous;
  for (const event of events) {
    if (!Number.isInteger(event?.seq) || event.seq <= state.lastSeq) continue;
    state = { ...state, lastSeq: event.seq };
    try {
      const payload = record(event.payload);
      const raw = record(payload?.raw);
      if (!payload || !raw || typeof event.kind !== 'string') continue;
      if (event.kind === 'state') {
        const current = string(raw.state);
        if (current) state = { ...state, runnerState: { state: current, ...(string(raw.stopReason) ? { stopReason: string(raw.stopReason) } : {}) } };
        continue;
      }
      if (event.kind === 'notice') {
        const severity = string(raw.severity) ?? string(raw.level) ?? 'info';
        const title = string(raw.title) ?? string(raw.message) ?? 'Notice';
        const description = string(raw.description);
        state = { ...state, notices: [...state.notices, { seq: event.seq, severity, title, ...(description ? { description } : {}) }] };
        continue;
      }
      if (event.kind === 'usage') {
        state = { ...state, usage: { ...(state.usage ?? {}), ...raw } };
        continue;
      }
      if (event.kind === 'commands' || event.kind === 'config' || event.kind === 'session_info') {
        state = { ...state, [event.kind === 'session_info' ? 'sessionInfo' : event.kind]: raw };
        continue;
      }
      if (event.kind === 'unknown') {
        state = { ...state, unknown: [...state.unknown, { seq: event.seq, name: string(raw.sessionUpdate) ?? 'unknown', text: safeText(raw) }] };
        continue;
      }
      state = { ...state, entities: applyEntity(state.entities, event.kind, raw, payload) };
    } catch {
      continue;
    }
  }
  return state;
}
