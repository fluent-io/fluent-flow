import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installSignalShutdown } from '../../bin/fluent-flow-runner.js';

describe('runner CLI signal shutdown', () => {
  it('waits for runner shutdown instead of exiting on a timer or second signal', async () => {
    const processLike = new EventEmitter();
    processLike.exit = vi.fn();
    processLike.exitCode = undefined;
    let finishShutdown;
    const runner = {
      shutdown: vi.fn(() => new Promise((resolve) => {
        finishShutdown = resolve;
      })),
    };
    const waitForShutdown = installSignalShutdown(runner, processLike);

    processLike.emit('SIGTERM');
    await Promise.resolve();
    expect(runner.shutdown).toHaveBeenCalledOnce();
    expect(processLike.exit).not.toHaveBeenCalled();

    processLike.emit('SIGINT');
    expect(processLike.exitCode).toBe(1);
    expect(processLike.exit).not.toHaveBeenCalled();

    finishShutdown();
    await waitForShutdown();
    expect(processLike.exit).not.toHaveBeenCalled();
  });
});
