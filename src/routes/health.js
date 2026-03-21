import { Router } from 'express';
import { healthCheck } from '../db/client.js';

const router = Router();

router.get('/health', async (req, res) => {
  try {
    const dbOk = await healthCheck();
    if (!dbOk) {
      return res.status(503).json({ status: 'error', db: 'unhealthy' });
    }
    res.json({ status: 'ok', db: 'healthy', uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'unreachable', error: err.message });
  }
});

export default router;
