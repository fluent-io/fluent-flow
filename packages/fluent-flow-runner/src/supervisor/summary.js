
export const NATIVE_CURSOR_EPOCH_PREFIX = 'ff-native-v1:';
const PAGE = 500;

/** @param {string} backend */
export function nativeCursorEpoch(backend) {
  return `${NATIVE_CURSOR_EPOCH_PREFIX}${backend}`;
}

/**
 * @param {any} payload
 * @returns {string | null}
 */
export function assistantTextOf(payload) {
  const text = payload?.type === 'assistant_text' ? payload.text
    : payload?.phase === 'completed' && payload.item?.type === 'agentMessage' ? payload.item.text : null;
  return typeof text === 'string' && text.trim() ? text : null;
}

export class SummarySourceIncomplete extends Error {
  /** @param {string} reason - protected detail for host logs */
  constructor(reason) {
    super(`Summary source history is incomplete: ${reason}`);
    this.name = 'SummarySourceIncomplete';
    this.code = 'summary_source_incomplete';
    this.reason = reason;
  }
}

/**
 * @param {{ ledger: ReturnType<typeof import('./ledger.js').createLedger>, runId: string, sessionId: string, sourceCursor: { epoch: string, seq: number } | null }} opts
 * @returns {Promise<string>}
 */
export async function summarySourceText({ ledger, runId, sessionId, sourceCursor }) {
  const seq = sourceCursor?.seq;
  if (!sourceCursor || typeof sourceCursor.epoch !== 'string' || !Number.isSafeInteger(seq) || seq < 1) throw new SummarySourceIncomplete('cursor_invalid');
  const binding = ledger.bindings().filter((b) => b.sessionId === sessionId && b.runId === runId).at(-1);
  if (!binding) throw new SummarySourceIncomplete('session_unknown');
  if (sourceCursor.epoch !== nativeCursorEpoch(binding.backend)) throw new SummarySourceIncomplete('cursor_domain_mismatch');
  const at = ledger.eventAt(seq);
  if (!at) throw new SummarySourceIncomplete('cursor_beyond_history');
  if (at.sessionId !== sessionId || at.runId !== runId) throw new SummarySourceIncomplete('cursor_session_mismatch');
  const texts = [];
  let after = 0;
  while (after < seq) {
    const batch = ledger.eventsAfter(after, Math.min(PAGE, seq - after));
    if (batch.length === 0) throw new SummarySourceIncomplete('history_gap');
    for (const event of batch) {
      if (event.seq !== after + 1) throw new SummarySourceIncomplete('history_gap');
      after = event.seq;
      if (event.sessionId !== sessionId || event.kind !== 'timeline') continue;
      const text = assistantTextOf(event.payload?.event);
      if (text !== null) texts.push(text);
    }
  }
  if (texts.length === 0) throw new SummarySourceIncomplete('no_assistant_text');
  return texts.join('\n\n');
}
