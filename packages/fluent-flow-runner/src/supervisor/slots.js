
export const SLOT_BACKENDS = Object.freeze(['claude-code', 'codex']);

/**
 * @param {{ activeTurn: boolean, pendingRequests: number, workerPid: number | null, cgroupPids: number[] | null, retainedPids?: number[], escaped: boolean, unverifiable: boolean }} activity
 * @returns {boolean}
 */
export function holdsSlot({ activeTurn, pendingRequests, workerPid, cgroupPids, retainedPids = [], escaped, unverifiable }) {
  if (activeTurn || pendingRequests > 0 || escaped || unverifiable) return true;
  if (!Array.isArray(cgroupPids)) return true;
  const retained = new Set(retainedPids);
  return cgroupPids.some((pid) => pid !== workerPid && !retained.has(pid));
}

/**
 * @param {{ ledger: { reserveSlot: Function, releaseSlot: Function, slotHolders: () => Map<string, string> }, limits: Record<string, number> }} opts
 */
export function createSlots({ ledger, limits }) {
  const held = (backend) => [...ledger.slotHolders()].filter(([, b]) => b === backend).map(([sessionId]) => sessionId);
  const available = () => Object.fromEntries(SLOT_BACKENDS.map((b) => [b, Math.max(0, (limits[b] ?? 1) - held(b).length)]));
  return {
    available,
    reserve(backend, sessionId) {
      const holders = ledger.slotHolders();
      if (holders.has(sessionId)) return holders.get(sessionId) === backend;
      if (available()[backend] <= 0) return false;
      ledger.reserveSlot({ sessionId, backend });
      return true;
    },
    release(sessionId) {
      if (ledger.slotHolders().has(sessionId)) ledger.releaseSlot({ sessionId });
    },
    snapshot() {
      return Object.fromEntries(SLOT_BACKENDS.map((b) => [b, { limit: limits[b] ?? 1, sessions: held(b) }]));
    },
    holderOf(sessionId) {
      return ledger.slotHolders().get(sessionId) ?? null;
    },
  };
}
