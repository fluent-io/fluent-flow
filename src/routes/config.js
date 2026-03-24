import { Router } from 'express';
import { resolveConfig } from '../config/loader.js';
import { invalidateConfig } from '../config/loader.js';
import logger from '../logger.js';

const router = Router();

// GET /api/config/:owner/:repo
router.get('/config/:owner/:repo', async (req, res) => {
  const { owner, repo } = req.params;
  try {
    const config = await resolveConfig(owner, repo);
    res.json({ owner, repo, config });
  } catch (err) {
    logger.error({ msg: 'Failed to resolve config', owner, repo, error: err.message });
    res.status(500).json({ error: 'Failed to resolve config', detail: err.message });
  }
});

// DELETE /api/config/:owner/:repo/cache — invalidate config cache
router.delete('/config/:owner/:repo/cache', async (req, res) => {
  const { owner, repo } = req.params;
  try {
    await invalidateConfig(owner, repo);
    res.json({ ok: true, message: `Config cache invalidated for ${owner}/${repo}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to invalidate cache', detail: err.message });
  }
});

export default router;
