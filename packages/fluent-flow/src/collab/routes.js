import { Router } from 'express';
import { collabErrorHandler, collabRequestContext, requireActor } from './http.js';
import { registerPublicRoutes } from './routes-public.js';
import { registerIdentityRoutes } from './routes-identity.js';
import { registerTaskRoutes } from './routes-tasks.js';
import { registerRunRoutes } from './routes-runs.js';
import { registerClaimExecutionRoutes } from './routes-claim-executions.js';
import { registerClaimProgressRoutes } from './routes-claim-progress.js';
import { registerHostRoutes } from './routes-hosts.js';
import { registerEvidenceRoutes } from './routes-evidence.js';

const router = Router();

router.use(collabRequestContext);
registerPublicRoutes(router);
router.use(requireActor);
registerIdentityRoutes(router);
registerTaskRoutes(router);
registerRunRoutes(router);
registerClaimExecutionRoutes(router);
registerClaimProgressRoutes(router);
registerHostRoutes(router);
registerEvidenceRoutes(router);
router.use(collabErrorHandler);

export default router;
