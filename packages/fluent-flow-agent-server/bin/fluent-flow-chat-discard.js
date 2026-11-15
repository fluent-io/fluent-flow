#!/usr/bin/env node
import { z } from 'zod';
import { createChatWorkspaceManager } from '../src/chat-workspace.js';
import { safeError } from '../src/safe-error.js';

const flags = new Map([['--work-dir', 'workDir'], ['--state-dir', 'storageDir'], ['--task-id', 'taskId'], ['--claim-id', 'claimId']]);
try {
  const options = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--confirm') { if (options.confirm) throw new Error('Duplicate confirmation'); options.confirm = true; continue; }
    const key = flags.get(argv[i]);
    if (!key || options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Invalid option');
    options[key] = argv[++i];
  }
  const parsed = z.object({ workDir: z.string().min(1), storageDir: z.string().min(1), taskId: z.uuid(), claimId: z.string().regex(/^[1-9][0-9]*$/u).transform(Number).pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)), confirm: z.literal(true) }).strict().parse(options);
  const manager = createChatWorkspaceManager({ workDir: parsed.workDir, storageDir: parsed.storageDir });
  await manager.discard(parsed);
  process.stdout.write('Retained workspace discarded.\n');
} catch (error) {
  console.error(safeError(error));
  process.stderr.write('Discard failed. Check the local workspace identity, inactive state and explicit --confirm option.\n');
  process.exitCode = 1;
}
