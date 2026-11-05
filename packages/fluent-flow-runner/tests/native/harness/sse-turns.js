
export function createTurnBook(script) {
  /** @type {{ turn: number, path: string, body: any, headers: Record<string, any>, aborted: boolean }[]} */
  const requests = [];
  /** @type {{ path: string, reason: string, body?: any }[]} */
  const unexpected = [];
  /** @type {Map<number, () => void>} */
  const releases = new Map();
  /** @type {Map<number, Promise<void>>} */
  const releasePromises = new Map();
  const released = new Set();
  let next = 0;

  function holdFor(turn) {
    if (!releasePromises.has(turn)) {
      releasePromises.set(
        turn,
        new Promise((r) => {
          releases.set(turn, () => r(undefined));
          if (released.has(turn)) r(undefined);
        }),
      );
    }
    return /** @type {Promise<void>} */ (releasePromises.get(turn));
  }

  return {
    requests,
    unexpected,
    claim(path, body, headers) {
      const turn = next++;
      const record = { turn, path, body, headers, aborted: false };
      requests.push(record);
      const spec = script[turn];
      if (!spec) unexpected.push({ path, reason: `main request ${turn} beyond script`, body });
      return { turn, spec, record };
    },
    holdFor,
    release(turn) {
      released.add(turn);
      releases.get(turn)?.();
    },
    pickTool(spec, names) {
      const match = typeof spec.tool === 'function' ? names.find(spec.tool) : names.find((n) => n === spec.tool);
      return match ?? null;
    },
  };
}
