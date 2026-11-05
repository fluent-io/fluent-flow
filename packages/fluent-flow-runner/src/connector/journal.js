import { join } from 'node:path';
import { createDurableLog, DurableLogCorruptionError } from './durable-log.js';


const RECORD_TYPES = new Set(['intent', 'binding', 'sent', 'acked', 'observation', 'observation_accepted', 'cursor', 'workspace_archived']);
export const RECOVERABLE_ACK_STATES = new Set(['accepted', 'ambiguous']);

export class JournalCorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JournalCorruptionError';
  }
}

export function createJournal({ dir, file = 'journal.jsonl' }) {
  const path = join(dir, file);
  let log;
  try {
    log = createDurableLog({ dir, file, recordTypes: RECORD_TYPES });
  } catch (err) {
    if (!(err instanceof DurableLogCorruptionError)) throw err;
    throw new JournalCorruptionError(err.reason === 'malformed'
      ? `Connector journal is corrupt at line ${err.line} of ${path}; original file preserved — move or repair it manually before reconnecting`
      : `Connector journal is corrupt: unknown record at line ${err.line} of ${path}; original file preserved — move or repair it manually before reconnecting`);
  }
  const entries = log.entries();
  const byId = new Map();
  const cursors = new Map();

  function record(commandId, entry) {
    if (!byId.has(commandId)) {
      byId.set(commandId, { intent: undefined, binding: undefined, sent: [], acked: undefined, observations: [] });
    }
    const rec = byId.get(commandId);
    switch (entry.type) {
      case 'intent': rec.intent = entry; break;
      case 'binding': rec.binding = entry; break;
      case 'sent': rec.sent.push(entry); break;
      case 'acked': rec.acked = entry; break;
      case 'observation': rec.observations.push(entry); break;
    }
    return rec;
  }

  for (const entry of entries) {
    if (entry.type === 'cursor') {
      cursors.set(entry.sessionId, { epoch: entry.epoch, seq: entry.seq });
    } else {
      record(entry.commandId, entry);
    }
  }

  return {
    async append(entry) {
      if (!entry || !RECORD_TYPES.has(entry.type)) {
        throw new Error(`Unknown journal record type: ${entry?.type}`);
      }
      if (entry.type === 'intent') {
        const existing = byId.get(entry.commandId)?.intent;
        if (existing && existing.payloadDigest !== entry.payloadDigest) {
          throw new Error(
            `Journal digest mismatch for command ${entry.commandId}: recorded ${existing.payloadDigest}, received ${entry.payloadDigest}`,
          );
        }
      }
      log.append(entry);
      if (entry.type === 'cursor') {
        cursors.set(entry.sessionId, { epoch: entry.epoch, seq: entry.seq });
      } else {
        record(entry.commandId, entry);
      }
    },

    byCommand(commandId) {
      return byId.get(commandId);
    },

    bindingForRun(runId) {
      for (const rec of byId.values()) {
        if (rec.intent?.runId === runId && rec.binding) return rec.binding;
      }
      return null;
    },

    bindingForSession(runId, sessionId) {
      for (const rec of byId.values()) {
        if (rec.intent?.runId === runId && rec.intent?.sessionId === sessionId && rec.binding) {
          return rec.binding;
        }
      }
      return null;
    },

    boundCommandIds() {
      return [...byId.entries()].filter(([, rec]) => rec.binding).map(([id]) => id);
    },

    workspaceArchive(runId, workspaceId) {
      if (![...byId.values()].some(({ binding }) => binding?.runId === runId && (binding.workspaceId ?? binding.workspaceRef) === workspaceId)) return null;
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry.runId !== runId || !(entry.type === 'workspace_archived' || (entry.type === 'observation' && entry.kind === 'wrapup'))) continue;
        const result = entry.type === 'workspace_archived' ? entry.result : entry.payload;
        const preflight = result?.preflight;
        const git = preflight?.git;
        const archivedAt = result?.archivedAt ?? entry.observedAt ?? entry.at;
        if (result?.ok !== true || result.phase !== 'archive' || result.archivedWorkspace !== true || preflight?.owned !== true ||
            preflight.runId !== runId || preflight.workspaceId !== workspaceId || !Array.isArray(preflight.blockers) || preflight.blockers.length ||
            git?.ok !== true || !/^[a-f0-9]{40,64}$/i.test(git.headCommit ?? '') || !git.upstream ||
            git.uncommitted !== 0 || git.untracked !== 0 || git.unpushed !== 0 || !Number.isFinite(Date.parse(archivedAt))) continue;
        return { workspaceId, archivedAt, git };
      }
      return null;
    },

    unackedCommandIds() {
      return [...byId.entries()]
        .filter(([, rec]) => rec.intent && (!rec.acked || RECOVERABLE_ACK_STATES.has(rec.acked.state)))
        .map(([id]) => id);
    },

    cursor(sessionId) {
      return cursors.get(sessionId);
    },

    pendingObservationIds() {
      const accepted = new Set(
        entries.filter((e) => e.type === 'observation_accepted').map((e) => e.eventId),
      );
      return [...new Set(entries.filter((e) => e.type === 'observation').map((e) => e.eventId))]
        .filter((id) => !accepted.has(id));
    },

    async markObservationsAccepted(eventIds) {
      for (const eventId of eventIds ?? []) {
        await this.append({ type: 'observation_accepted', eventId, at: new Date().toISOString() });
      }
    },

    observationsForSession(runId, sessionId) {
      const byEvent = new Map();
      for (const e of entries) if (e.type === 'observation' && e.runId === runId && e.sessionId === sessionId) byEvent.set(e.eventId, e);
      return [...byEvent.values()];
    },

    observationById(eventId) {
      return entries.filter((e) => e.type === 'observation' && e.eventId === eventId).pop();
    },
  };
}
