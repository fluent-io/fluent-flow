import fs from 'node:fs';
import { join } from 'node:path';


const RECORD_TYPES = new Set(['intent', 'binding', 'sent', 'acked', 'observation', 'observation_accepted', 'cursor', 'workspace_archived']);
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
      fs.truncateSync(path, goodBytes);
    }
    return { entries: completeLines.map((l) => JSON.parse(l)) };
  }

  const loaded = load();
  if (corruption) {
    throw corruption;
  }
  const entries = loaded?.entries ?? [];
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

    byCommand(commandId) {
      assertClean();
      return byId.get(commandId);
    },

    bindingForRun(runId) {
      assertClean();
      for (const rec of byId.values()) {
        if (rec.intent?.runId === runId && rec.binding) return rec.binding;
      }
      return null;
    },

    bindingForSession(runId, sessionId) {
      assertClean();
      for (const rec of byId.values()) {
        if (rec.intent?.runId === runId && rec.intent?.sessionId === sessionId && rec.binding) {
          return rec.binding;
        }
      }
      return null;
    },

    boundCommandIds() {
      assertClean();
      return [...byId.entries()].filter(([, rec]) => rec.binding).map(([id]) => id);
    },

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

    unackedCommandIds() {
      assertClean();
      return [...byId.entries()]
        .filter(([, rec]) => rec.intent && (!rec.acked || RECOVERABLE_ACK_STATES.has(rec.acked.state)))
        .map(([id]) => id);
    },

    cursor(sessionId) {
      assertClean();
      return cursors.get(sessionId);
    },

    pendingObservationIds() {
      assertClean();
      const accepted = new Set(
        entries.filter((e) => e.type === 'observation_accepted').map((e) => e.eventId),
      );
      return [...new Set(entries.filter((e) => e.type === 'observation').map((e) => e.eventId))]
        .filter((id) => !accepted.has(id));
    },

    async markObservationsAccepted(eventIds) {
      assertClean();
      for (const eventId of eventIds ?? []) {
        await this.append({ type: 'observation_accepted', eventId, at: new Date().toISOString() });
      }
    },

    observationById(eventId) {
      assertClean();
      return entries.filter((e) => e.type === 'observation' && e.eventId === eventId).pop();
    },
  };
}
