import {
  CollabServiceError,
  listTaskClaimProgress,
  markClaimReadCursor,
} from '@fluent-flow/db';

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

export function registerClaimProgressRoutes(router) {
  router.get('/tasks/:id/claim-progress', async (req, res, next) => {
    try {
      const result = await listTaskClaimProgress({ actor: req.collabActor, taskId: req.params.id });
      res.json({ data: result.claims, terminalTruncated: result.terminalTruncated });
    } catch (error) {
      next(error);
    }
  });

  router.post('/claim-executions/:claimId/read-cursor', async (req, res, next) => {
    try {
      const result = await markClaimReadCursor({
        actor: req.collabActor,
        claimId: parseClaimId(req.params.claimId),
        seq: req.body?.seq,
      });
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });
}
