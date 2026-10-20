import { acceptCollabInvitation } from '@fluent-flow/db';
import { collabRateLimitKey, optionalVerifiedActor } from './http.js';

/**
 * Public (pre-boundary) collaboration routes. The only unauthenticated
 * collaboration mutation is invitation redemption: secret-token bound,
 * throttled by a server-derived key, and never returning an actor assertion.
 * An acting principal is derived ONLY from a verified X-Fluent-Flow-Actor
 * header — body-supplied actor fields are ignored.
 */
export function registerPublicRoutes(router) {
  router.post('/invitations/accept', async (req, res, next) => {
    try {
      const { actor, rejected } = await optionalVerifiedActor(req, res);
      if (rejected) return;
      const result = await acceptCollabInvitation({
        token: req.body?.token,
        displayName: req.body?.displayName,
        password: req.body?.password,
        rateLimitKey: collabRateLimitKey(req),
        actor,
      });
      res.status(201).json({ data: result });
    } catch (err) {
      next(err);
    }
  });
}
