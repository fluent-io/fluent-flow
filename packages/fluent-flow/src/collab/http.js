import { randomUUID } from 'node:crypto';
import {
  getPool,
  rateLimitBucket,
  verifyCollaborationActor,
  CollabAssertionError,
  CollabServiceError,
} from '@fluent-flow/db';
import { ZodError } from 'zod';
import logger from '../logger.js';

const ACTOR_HEADER = 'x-fluent-flow-actor';

export function sendCollabError(res, status, code, message, requestId) {
  res.status(status).json({ error: { code, message, requestId } });
}

export function collabRequestContext(req, res, next) {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

function actorHeaderCount(req) {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === ACTOR_HEADER) count += 1;
  }
  return count;
}

async function authenticateActor(req, res) {
  if (actorHeaderCount(req) > 1) {
    logger.warn({ msg: 'collab actor assertion rejected', reason: 'duplicate_headers', requestId: req.requestId });
    sendCollabError(res, 401, 'unauthenticated', 'Authentication required.', req.requestId);
    return { status: 'rejected' };
  }

  const assertion = req.headers[ACTOR_HEADER];
  if (typeof assertion !== 'string' || assertion.length === 0) {
    return { status: 'anonymous' };
  }

  const secret = process.env.FF_COLLAB_AUTH_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) {
    logger.error({ msg: 'collab auth secret is not configured', requestId: req.requestId });
    sendCollabError(res, 503, 'unavailable_configuration', 'Configuration error. Contact support.', req.requestId);
    return { status: 'rejected' };
  }

  let actor;
  try {
    actor = verifyCollaborationActor(assertion, secret);
  } catch (err) {
    const reason = err instanceof CollabAssertionError ? err.reason : 'invalid';
    logger.warn({ msg: 'collab actor assertion rejected', reason, requestId: req.requestId });
    sendCollabError(res, 401, 'unauthenticated', 'Authentication required.', req.requestId);
    return { status: 'rejected' };
  }

  const { rows } = await getPool().query(
    `SELECT id FROM collab_principals
     WHERE id = $1 AND disabled_at IS NULL AND session_version = $2`,
    [actor.principalId, actor.sessionVersion],
  );
  if (rows.length === 0) {
    logger.warn({
      msg: 'collab actor principal rejected',
      reason: 'principal_unknown_disabled_or_stale',
      requestId: req.requestId,
    });
    sendCollabError(res, 401, 'unauthenticated', 'Authentication required.', req.requestId);
    return { status: 'rejected' };
  }

  return { status: 'authenticated', actor };
}

export async function requireActor(req, res, next) {
  const outcome = await authenticateActor(req, res);
  if (outcome.status === 'authenticated') {
    req.collabActor = outcome.actor;
    return next();
  }
  if (outcome.status === 'anonymous') {
    return sendCollabError(res, 401, 'unauthenticated', 'Authentication required.', req.requestId);
  }
}

export async function optionalVerifiedActor(req, res) {
  const outcome = await authenticateActor(req, res);
  if (outcome.status === 'authenticated') return { actor: outcome.actor };
  if (outcome.status === 'anonymous') return { actor: undefined };
  return { rejected: true };
}

export function collabRateLimitKey(req) {
  const peer = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  return rateLimitBucket('conn', peer, '');
}

export function collabErrorHandler(err, req, res, _next) {
  if (err instanceof CollabServiceError) {
    if (err.status >= 500) {
      logger.error({ msg: 'collab service error', code: err.code, requestId: req.requestId });
    }
    const error = { code: err.code, message: err.message, requestId: req.requestId, ...(err.details ?? {}) };
    return res.status(err.status).json({ error });
  }
  if (err instanceof ZodError) {
    logger.warn({ msg: 'collab request validation failed', requestId: req.requestId });
    return sendCollabError(res, 400, 'malformed', 'Invalid request.', req.requestId);
  }
  logger.error({
    msg: 'collab request failed',
    error: err.message,
    stack: err.stack,
    requestId: req.requestId,
  });
  return sendCollabError(res, 500, 'internal_error', 'Configuration error. Contact support.', req.requestId);
}
