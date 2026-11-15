import { it, expect } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createChatWorkspaceManager } from '../../src/chat-workspace.js';
const exec = promisify(execFile);
it('requires explicit local confirmation and discards only the named inactive receipt workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ff-chat-discard-'));
  try {
    const workDir = join(root, 'work'), storageDir = join(root, 'state');
    const taskId = '11111111-1111-4111-8111-111111111111';
    const manager = createChatWorkspaceManager({ workDir, storageDir });
    const w = await manager.prepare({ task_id: taskId, claim_id: 1, repo: null }); await w.release();
    const args = [resolve('bin/fluent-flow-chat-discard.js'), '--work-dir', workDir, '--state-dir', storageDir, '--task-id', taskId, '--claim-id', '1'];
    await expect(exec(process.execPath, args)).rejects.toThrow();
    await access(w.path);
    const result = await exec(process.execPath, [...args, '--confirm']);
    expect(result.stdout).toContain('discarded');
    await expect(access(w.path)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
