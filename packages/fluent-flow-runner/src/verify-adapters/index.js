import vitest from './vitest.js';
import jest from './jest.js';
import node from './node.js';
import { detectFrameworkFor } from './shared.js';

export const adapters = new Map([
  ['vitest', vitest],
  ['jest', jest],
  ['node', node],
]);

export { vitest, jest, node };

export function detectFramework(worktreePath) {
  for (const [id, adapter] of adapters) {
    const detected = adapter.detect(worktreePath);
    if (detected) return detected;
  }
  return null;
}

export { detectFrameworkFor };
export default adapters;
