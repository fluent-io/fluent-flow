#!/usr/bin/env node

const args = process.argv.slice(2);
const inventory = args.length === 1 && args[0] === 'inventory';
const freeze = args.length === 2 && args[0] === 'freeze' && args[1] === '--confirm-all-legacy-execution';

if (!inventory && !freeze) {
  process.stderr.write('Invalid arguments. Use inventory or explicitly confirm a global freeze.\n');
  process.exitCode = 1;
} else {
  let closePool;
  try {
    const services = await import('../dist/collaboration/execution-retirement.js');
    closePool = (await import('../dist/pool.js')).closePool;
    const result = inventory ? await services.readLegacyExecutionInventory() : await services.freezeLegacyExecution();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const busy = error !== null && typeof error === 'object' && 'code' in error && error.code === 'legacy_execution_busy';
    process.stderr.write(busy ? 'Execution admissions are busy. No freeze was applied.\n' : 'Retirement operation failed.\n');
    process.exitCode = 1;
  } finally {
    if (closePool) {
      try {
        await closePool();
      } catch {
        process.stderr.write('Retirement operation failed.\n');
        process.exitCode = 1;
      }
    }
  }
}
