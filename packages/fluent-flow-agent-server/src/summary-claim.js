import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

export function createSummaryScratch({ workDir, claimId }) {
  if (typeof workDir !== 'string' || workDir.length === 0) throw new Error('Summary work directory is required');
  if (!Number.isSafeInteger(claimId) || claimId <= 0) throw new Error('Summary claim is invalid');
  let path = null;
  return {
    async prepare() {
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      path = await mkdtemp(join(workDir, `summary-${claimId}-`));
      return { path };
    },
    get path() {
      if (path === null) throw new Error('Summary scratch is not prepared');
      return path;
    },
    cleanup: async () => {
      if (path === null) return;
      await rm(path, { recursive: true, force: true });
    },
  };
}
