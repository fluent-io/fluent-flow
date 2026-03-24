/**
 * Shared logger mock shape for tests.
 * Keeps the mock aligned with src/logger.js in one place.
 *
 * Usage in test files (vi.mock is hoisted, so use vi.hoisted):
 *   const { mockLogger } = vi.hoisted(() => await import('../helpers/mock-logger.js'));
 *   vi.mock('../../src/logger.js', () => ({ default: mockLogger() }));
 *
 * Or simply inline (vi.mock factories can call vi.fn()):
 *   vi.mock('../../src/logger.js', () => ({ default: createMockLogger() }));
 */
import { vi } from 'vitest';

export function createMockLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}
