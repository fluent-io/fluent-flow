import {
  CollabServiceError,
  getCollabClaimExecution,
  listCollabClaimEvents,
  listCollabClaimExecutions,
  listCollabClaimRequests,
  startCollabClaimExecution,
  submitCollabClaimCommand,
} from '@fluent-flow/db';

function requireIdempotencyKey(req) {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 256) {
    throw new CollabServiceError(
      400,
      'idempotency_key_required',
      'Idempotency-Key header (8-256 chars) is required.',
    );
  }
  return key;
}

function parseClaimId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const claimId = Number(value);
  if (!Number.isSafeInteger(claimId) || claimId > 2147483647) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  return claimId;
}

function parseLimit(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new CollabServiceError(400, 'malformed', 'Invalid request.');
  }
  return Number(value);
}

function queryCursor(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new CollabServiceError(400, 'invalid_cursor', 'The cursor is invalid.');
  }
  return value;
}

export function registerClaimExecutionRoutes(router) {
  router.post('/tasks/:id/claim-executions', async (req, res, next) => {
    try {
      const result = await startCollabClaimExecution({
        actor: req.collabActor,
        taskId: req.params.id,
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: requireIdempotencyKey(req),
        repo: req.body?.repo,
        prNumber: req.body?.prNumber,
        branch: req.body?.branch,
        claimType: req.body?.claimType,
        instructions: req.body?.instructions,
      });
      res.status(result.created ? 202 : 200).json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  router.get('/tasks/:id/claim-executions', async (req, res, next) => {
    try {
      const result = await listCollabClaimExecutions({
        actor: req.collabActor,
        taskId: req.params.id,
        cursor: queryCursor(req.query.cursor),
        limit: parseLimit(req.query.limit),
      });
      res.json({ data: result.claims, nextCursor: result.nextCursor });
    } catch (error) {
      next(error);
    }
  });

  router.get('/claim-executions/:claimId', async (req, res, next) => {
    try {
      const result = await getCollabClaimExecution({
        actor: req.collabActor,
        claimId: parseClaimId(req.params.claimId),
      });
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  router.get('/claim-executions/:claimId/events', async (req, res, next) => {
    try {
      const result = await listCollabClaimEvents({
        actor: req.collabActor,
        claimId: parseClaimId(req.params.claimId),
        cursor: queryCursor(req.query.cursor),
        limit: parseLimit(req.query.limit),
      });
      res.json({ data: result.events, nextCursor: result.nextCursor });
    } catch (error) {
      next(error);
    }
  });

  router.get('/claim-executions/:claimId/requests', async (req, res, next) => {
    try {
      const result = await listCollabClaimRequests({
        actor: req.collabActor,
        claimId: parseClaimId(req.params.claimId),
        cursor: queryCursor(req.query.cursor),
        limit: parseLimit(req.query.limit),
      });
      res.json({ data: result.requests, nextCursor: result.nextCursor });
    } catch (error) {
      next(error);
    }
  });

  router.post('/claim-executions/:claimId/commands', async (req, res, next) => {
    try {
      const result = await submitCollabClaimCommand({
        ...(req.body ?? {}),
        actor: req.collabActor,
        claimId: parseClaimId(req.params.claimId),
        idempotencyKey: requireIdempotencyKey(req),
      });
      res.status(result.created ? 202 : 200).json({ data: result });
    } catch (error) {
      next(error);
    }
  });
}
