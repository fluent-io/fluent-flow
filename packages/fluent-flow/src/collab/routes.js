import { Router } from 'express';
import { collabErrorHandler, collabRequestContext, requireActor } from './http.js';
import { registerPublicRoutes } from './routes-public.js';
import { registerIdentityRoutes } from './routes-identity.js';
import { registerTaskRoutes } from './routes-tasks.js';
import { registerRunRoutes } from './routes-runs.js';
import { registerHostRoutes } from './routes-hosts.js';
import { registerEvidenceRoutes } from './routes-evidence.js';

/**
 * Collaboration API (/api/collab/v1). Order matters:
 * 1. request context (request IDs),
 * 2. public routes (invitation redemption only),
 * 3. the actor-assertion boundary,
 * 4. authenticated resources (services re-check principal/membership/capabilities),
 * 5. the terminal error mapping.
 *
 * Contract: docs/plans/2026-10-19-collaborative-contracts.md.
 */
const router = Router();

router.use(collabRequestContext);
registerPublicRoutes(router);
router.use(requireActor);
registerIdentityRoutes(router);
registerTaskRoutes(router);
registerRunRoutes(router);
registerHostRoutes(router);
registerEvidenceRoutes(router);
router.use(collabErrorHandler);

export default router;
