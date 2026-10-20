import fs from 'node:fs';
import { join } from 'node:path';

/**
 * Durable local launch journal for the connector.
 *
 * Before the connector performs any SDK side effect (workspace/agent creation,
 * prompt send, cancel) it records the intent here. The journal is the source of
 * truth for "what was this connector about to do" across crashes and restarts:
 * recovery replays recorded run/session identities and never re-derives them.
 *
 * Format: append-only JSONL, one record per line. Durability contract per
 * append: write ALL bytes, fsync(file), fsync(directory).
 *
 * Crash/corruption rules:
 * - A final line WITHOUT its trailing newline is a torn write (valid JSON or
 *   not): it is truncated away on load and the next append starts clean.
 * - Any malformed or unknown record in the MIDDLE of the file is corruption we
 *   cannot safely repair — records after it may be bindings/prompts for live
 *   runs. Loading fails closed: the instance refuses reads, the original file
 *   is preserved byte-for-byte for manual inspection. Only the operator moves
 *   or fixes the file; the connector never truncates mid-file data.
 *
 * File/dir privacy: created 0600/0700 regardless of umask; an existing file is
 * chmod'ed back to 0600 on open.
 *
 * Record types (latest wins per type within a command; sent/cursors accumulate):
 * - {type:'intent', commandId, runId, sessionId, kind, payloadDigest, recordedAt}
 * - {type:'binding', commandId, runId, sessionId, workspaceId, paseoAgentId, providerSessionId}
 * - {type:'sent', commandId, messageId, at}
 * - {type:'acked', commandId, state:'accepted'|'applied'|'failed'|'ambiguous', errorCode?, at}
 * - {type:'observation', eventId, commandId?, runId, sessionId, kind, at}
 * - {type:'cursor', sessionId, epoch, seq}
 * - {type:'workspace_archived', runId, workspaceId, result, at}
 */

const RECORD_TYPES = new Set(['intent', 'binding', 'sent', 'acked', 'observation', 'observation_accepted', 'cursor', 'workspace_archived']);
/** Ack states that still need recovery work after a restart. */
export const RECOVERABLE_ACK_STATES = new Set(['accepted', 'ambiguous']);

export class JournalCorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JournalCorruptionError';
  }
}

function writeFull(fd, string) {
  const bytes = Buffer.from(string, 'utf8');
  let written = 0;
  while (written < bytes.length) {
    written += fs.writeSync(fd, bytes, written, bytes.length - written);
  }
  return written;
}

export function createJournal({ dir, file = 'journal.jsonl' }) {
  const path = join(dir, file);
  let corruption = null;

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    if (raw === '') return;
    const lines = raw.split('\n');
    const completeLines = lines.slice(0, -1);
    const trailing = lines[lines.length - 1];
    let goodBytes = 0;
    for (let i = 0; i < completeLines.length; i++) {
      const line = completeLines[i];
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        corruption = new JournalCorruptionError(
          `Connector journal is corrupt at line ${i + 1} of ${path}; original file preserved — move or repair it manually before reconnecting`,
        );
        return;
      }
      if (!parsed || typeof parsed !== 'object' || !RECORD_TYPES.has(parsed.type)) {
        corruption = new JournalCorruptionError(
          `Connector journal is corrupt: unknown record at line ${i + 1} of ${path}; original file preserved — move or repair it manually before reconnecting`,
        );
        return;
      }
      goodBytes += Buffer.byteLength(line, 'utf8') + 1;
    }
    if (trailing !== '') {
      // Unterminated final line: a crash mid-write, even if the JSON parses.
      // Truncate so the next append lands on a clean line boundary.
      fs.truncateSync(path, goodBytes);
    }
    return { entries: completeLines.map((l) => JSON.parse(l)) };
  }

  const loaded = load();
  if (corruption) {
    // Fail closed: refuse to construct a journal that cannot be trusted to
    // recover commands. The original file was not modified.
    throw corruption;
  }
  const entries = loaded?.entries ?? [];
  const byId = new Map(); // commandId -> { intent, binding, sent[], acked, observations[] }
  const cursors = new Map(); // sessionId -> {epoch, seq}

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

  function assertClean() {
    if (corruption) throw corruption;
  }

  function fsyncDir() {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  return {
    /**
     * Durably record one journal entry. Rejects an intent re-append for the
     * same command with a different payload digest: that combination means the
     * server re-delivered a changed payload under a stable command id, which
     * must never be executed from stale journal context.
     */
    async append(entry) {
      assertClean();
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
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const line = JSON.stringify(entry);
      let fd;
      try {
        // 0600 at creation (no privacy window); chmod repairs pre-existing files.
        fd = fs.openSync(path, 'a', 0o600);
        fs.chmodSync(path, 0o600);
        writeFull(fd, line + '\n');
        fs.fsyncSync(fd);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      fsyncDir();
      if (entry.type === 'cursor') {
        cursors.set(entry.sessionId, { epoch: entry.epoch, seq: entry.seq });
      } else {
        record(entry.commandId, entry);
      }
      entries.push(entry);
    },

    /** Full record set for one command, or undefined. Fails closed if corrupt. */
    byCommand(commandId) {
      assertClean();
      return byId.get(commandId);
    },

    /**
     * The launch binding journaled for a run (workspace/agent ids), regardless
     * of whether its launch command is already acknowledged.
     */
    bindingForRun(runId) {
      assertClean();
      for (const rec of byId.values()) {
        if (rec.intent?.runId === runId && rec.binding) return rec.binding;
      }
      return null;
    },

    /**
     * The binding for one EXACT session of a run. With multiple sessions per
     * run, prompts/permissions/cancels must target the addressed session.
     */
    bindingForSession(runId, sessionId) {
      assertClean();
      for (const rec of byId.values()) {
        if (rec.intent?.runId === runId && rec.intent?.sessionId === sessionId && rec.binding) {
          return rec.binding;
        }
      }
      return null;
    },

    /** Command ids that have a journaled binding, in journal order. */
    boundCommandIds() {
      assertClean();
      return [...byId.entries()].filter(([, rec]) => rec.binding).map(([id]) => id);
    },

    /** Confirmed owned cleanup freezes Git evidence as historical. Older
     * successful wrapup observations are equally durable receipts. A missing
     * workspace or a failed/session-only cleanup never grants this authority. */
    workspaceArchive(runId, workspaceId) {
      assertClean();
      if (![...byId.values()].some(({ binding }) => binding?.runId === runId && binding.workspaceId === workspaceId)) return null;
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

    /**
     * Command ids that still need recovery attention after a restart, in
     * journal order: any intent without a terminal ack. `accepted` (ack
     * received, never applied) and `ambiguous` (side effect unknown) stay
     * pending so recovery can reconcile or hold them; `applied`/`failed` are
     * terminal.
     */
    unackedCommandIds() {
      assertClean();
      return [...byId.entries()]
        .filter(([, rec]) => rec.intent && (!rec.acked || RECOVERABLE_ACK_STATES.has(rec.acked.state)))
        .map(([id]) => id);
    },

    /** Latest persisted timeline cursor for a session, or undefined. */
    cursor(sessionId) {
      assertClean();
      return cursors.get(sessionId);
    },

    /**
     * Observation event ids not yet CONFIRMED by the control plane, in
     * journal order. Server acceptances are checkpointed (`markObservationsAccepted`)
     * so a restart never resubmits all historical observations.
     */
    pendingObservationIds() {
      assertClean();
      const accepted = new Set(
        entries.filter((e) => e.type === 'observation_accepted').map((e) => e.eventId),
      );
      return [...new Set(entries.filter((e) => e.type === 'observation').map((e) => e.eventId))]
        .filter((id) => !accepted.has(id));
    },

    /** Durably checkpoint control-plane acceptance of observation event ids. */
    async markObservationsAccepted(eventIds) {
      assertClean();
      for (const eventId of eventIds ?? []) {
        await this.append({ type: 'observation_accepted', eventId, at: new Date().toISOString() });
      }
    },

    /** One observation record by event id, or undefined. */
    observationById(eventId) {
      assertClean();
      return entries.filter((e) => e.type === 'observation' && e.eventId === eventId).pop();
    },
  };
}
