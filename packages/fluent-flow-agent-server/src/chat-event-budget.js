const CRITICAL = new Set(['state', 'user_message', 'config', 'notice']);
export function createChatEventBudget({ totalBytes = 16 * 1024 * 1024, reserveBytes = 4 * 1024 * 1024 } = {}) {
  let bytes = 0;
  let marked = false;
  const markerCharge = 2048;
  return {
    get bytes() { return bytes; },
    admit(event) {
      const charge = Buffer.byteLength(JSON.stringify(event.payload), 'utf8') * 2 + 1024;
      const ceiling = totalBytes - (CRITICAL.has(event.kind) ? markerCharge : reserveBytes);
      if (bytes + charge <= ceiling) { bytes += charge; return 'keep'; }
      if (!marked) { marked = true; bytes += markerCharge; return 'truncate'; }
      return 'drop';
    },
  };
}
