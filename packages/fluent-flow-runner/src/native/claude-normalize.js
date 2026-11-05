
import { createHash } from 'node:crypto';

const ABORT_REASONS = new Set(['aborted_streaming', 'aborted_tools']);
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];

const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

function baseId(event) {
  if (typeof event.uuid === 'string' && event.uuid) return event.uuid;
  return `sha256:${createHash('sha256').update(JSON.stringify(event)).digest('hex')}`;
}

function blocksOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function usageEvent(event, id) {
  const entries = event.modelUsage && typeof event.modelUsage === 'object' ? Object.entries(event.modelUsage) : [];
  const samples = entries.length
    ? entries.map(([model, usage]) => {
        const sample = { model };
        for (const field of USAGE_FIELDS) sample[field] = count(usage?.[field]);
        const cost = count(usage?.costUSD);
        sample.cost = cost === null ? null : { amount: cost, currency: 'USD', estimate: true };
        return sample;
      })
    : null;
  return { kind: 'usage', nativeEventId: `${id}:usage`, payload: { samples } };
}

function terminalEvent(event, id, ctx) {
  const failed = event.is_error === true || event.subtype !== 'success';
  const commandIds = Array.isArray(event.user_message_uuids) ? [...event.user_message_uuids] : [];
  let terminal = 'completed';
  let errorCode = null;
  if (failed) {
    if (ctx.modelUnavailable) {
      terminal = 'failed';
      errorCode = 'profile_unavailable';
    } else if (ctx.accountLimited) {
      terminal = 'account_limited';
      errorCode = 'account_limited';
    } else terminal = ABORT_REASONS.has(event.terminal_reason) ? 'interrupted' : 'failed';
  }
  ctx.modelUnavailable = false;
  ctx.accountLimited = false;
  return { kind: 'state', nativeEventId: id, terminal, payload: { phase: 'result', errorCode, commandIds } };
}

function assistantItems(event, id, ctx) {
  if (event.error === 'model_not_found') ctx.modelUnavailable = true;
  if (event.error === 'rate_limit' && event.api_error === 'usage_limit_reached' && event.api_error_params?.rate_limit_info?.status === 'rejected') ctx.accountLimited = true;
  if (event.is_api_error_message === true) return [];
  const parentToolUseId = event.parent_tool_use_id ?? null;
  return blocksOf(event.message).map((block, index) => {
    const nativeEventId = `${id}:${index}`;
    if (block.type === 'text') return { kind: 'timeline', nativeEventId, payload: { type: 'assistant_text', text: block.text, parentToolUseId } };
    if (block.type === 'thinking') return { kind: 'timeline', nativeEventId, payload: { type: 'thinking', text: block.thinking, parentToolUseId } };
    if (block.type === 'tool_use') {
      return { kind: 'timeline', nativeEventId, payload: { type: 'tool_use', toolUseId: block.id, name: block.name, input: block.input, parentToolUseId } };
    }
    return { kind: 'timeline', nativeEventId, payload: { type: 'assistant_block', block, parentToolUseId } };
  });
}

function userItems(event, id) {
  const blocks = blocksOf(event.message);
  if (event.isReplay === true) {
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return [{ kind: 'timeline', nativeEventId: id, receiptFor: event.uuid, payload: { type: 'user_message', text } }];
  }
  return blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === 'tool_result')
    .map(({ block, index }) => ({
      kind: 'timeline',
      nativeEventId: `${id}:${index}`,
      payload: {
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        isError: block.is_error === true,
        content: block.content,
        toolUseResult: event.tool_use_result ?? null,
        parentToolUseId: event.parent_tool_use_id ?? null,
      },
    }));
}

function streamItems(event, id) {
  const inner = event.event;
  if (inner?.type !== 'content_block_delta') return [];
  const delta = inner.delta;
  const common = { messageId: event.api_message_id ?? null, index: inner.index, parentToolUseId: event.parent_tool_use_id ?? null };
  if (delta?.type === 'text_delta') return [{ kind: 'timeline', nativeEventId: id, payload: { type: 'assistant_delta', text: delta.text, ...common } }];
  if (delta?.type === 'thinking_delta') return [{ kind: 'timeline', nativeEventId: id, payload: { type: 'thinking_delta', text: delta.thinking, ...common } }];
  return [];
}

/**
 * @param {any} event one parsed stream-json line (control messages are handled by claude-control.js)
 * @param {{ modelUnavailable?: boolean }} ctx per-worker state, shared across calls. The normalizer sets
 * @returns {Array<{ kind: string, nativeEventId: string, payload: any, receiptFor?: string, terminal?: string }>}
 */
export function normalizeClaudeEvent(event, ctx) {
  if (!event || typeof event !== 'object') return [];
  const id = baseId(event);
  switch (event.type) {
    case 'assistant':
      return assistantItems(event, id, ctx);
    case 'user':
      return userItems(event, id);
    case 'stream_event':
      return streamItems(event, id);
    case 'result':
      return [usageEvent(event, id), terminalEvent(event, id, ctx)];
    case 'rate_limit_event': {
      const info = event.rate_limit_info;
      if (!info || typeof info !== 'object' || typeof info.status !== 'string') return [];
      return [{ kind: 'state', nativeEventId: id, payload: { phase: 'rate_limit', status: info.status, rateLimitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : null } }];
    }
    case 'command_lifecycle':
      return [{ kind: 'state', nativeEventId: id, payload: { phase: 'command', commandId: event.command_uuid, lifecycle: event.state } }];
    case 'system':
      if (event.subtype === 'init') {
        const mcpServers = Array.isArray(event.mcp_servers) ? event.mcp_servers.map(({ name, status }) => ({ name, status })) : [];
        return [{ kind: 'state', nativeEventId: id, payload: { phase: 'init', model: event.model, permissionMode: event.permissionMode, mcpServers } }];
      }
      if (event.subtype === 'status') return [{ kind: 'state', nativeEventId: id, payload: { phase: 'status', status: event.status } }];
      return [];
    default:
      return [];
  }
}
