import { Router } from 'express';
import { healthCheck } from '../db/client.js';

const router = Router();

// Collaboration routes (collab/http.js, collab/routes.js) silently 503 every
// authenticated request when this is unset — surface that at the health
// endpoint so a misconfigured deploy fails its readiness check instead of
// going live broken.
const REQUIRED_ENV_VARS = ['FF_COLLAB_AUTH_SECRET'];

router.get('/health', async (req, res) => {
  const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missingEnvVars.length > 0) {
    return res.status(503).json({ status: 'error', missingEnvVars });
  }

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
