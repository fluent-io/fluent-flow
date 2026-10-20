import { Router } from 'express';
import {
  CollabServiceError,
  getCollabRun,
  listCollabRuns,
  startCollabRun,
  updateRunStage,
  createRunSession,
  submitSessionCommand,
  getConnectorCommand,
  getSessionPendingRequest,
  queueRunCommand,
  getSessionTimeline,
  reconcileConnectorCommand,
  updateProjectExecutionDefaults,
  createCollabComment,
  listCollabComments,
  listTaskEvents,
  markTaskRead,
  listAttention,
} from '@fluent-flow/db';

function requireIdempotencyKey(req) {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 256) {
    throw new CollabServiceError(400, 'idempotency_key_required', 'Idempotency-Key header (8-256 chars) is required.');
  }
  return key;
}

/**
 * Run/session execution surfaces (A3) behind the actor-assertion boundary.
 * All authorization, idempotency and fencing live in the domain services.
 */
export function registerRunRoutes(router) {
  router.get('/tasks/:id/runs', async (req, res, next) => {
    try {
      const result = await listCollabRuns({ actor: req.collabActor, taskId: req.params.id });
      res.json({ data: result.runs, nextCursor: result.nextCursor });
    } catch (err) {
      next(err);
    }
  });

  // Queued command → 202 per contract.
  router.post('/tasks/:id/runs', async (req, res, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(req);
      const result = await startCollabRun({
        actor: req.collabActor,
        taskId: req.params.id,
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey,
        mappingId: req.body?.mappingId,
        profileId: req.body?.profileId,
        model: req.body?.model,
        instructions: req.body?.instructions,
        retryOfRunId: req.body?.retryOfRunId,
      });
      res.status(result.created ? 202 : 200).json({
        data: result,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/runs/:id', async (req, res, next) => {
    try {
      const detail = await getCollabRun(req.collabActor, req.params.id);
      res.json({ data: detail });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/runs/:id', async (req, res, next) => {
    try {
      const run = await updateRunStage({
        actor: req.collabActor,
        runId: req.params.id,
        expectedVersion: req.body?.expectedVersion,
        stage: req.body?.stage,
      });
      res.json({ data: run });
    } catch (err) {
      next(err);
    }
  });

  router.post('/runs/:id/sessions', async (req, res, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(req);
      const result = await createRunSession({
        actor: req.collabActor,
        runId: req.params.id,
        idempotencyKey,
        title: req.body?.title,
        profileId: req.body?.profileId,
        model: req.body?.model,
        instructions: req.body?.instructions ?? '',
      });
      res.status(result.created ? 202 : 200).json({
        data: { session: result.session, commandId: result.commandId, created: result.created },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/sessions/:id/commands', async (req, res, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(req);
      const result = await submitSessionCommand({
        actor: req.collabActor,
        sessionId: req.params.id,
        idempotencyKey,
        command: req.body,
      });
      res.status(result.created ? 202 : 200).json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.get('/commands/:id', async (req, res, next) => {
    try {
      const command = await getConnectorCommand(req.collabActor, req.params.id);
      res.json({ data: command });
    } catch (err) {
      next(err);
    }
  });

  router.post('/commands/:id/reconcile', async (req, res, next) => {
    try {
      const result = await reconcileConnectorCommand({
        actor: req.collabActor,
        commandId: req.params.id,
        action: req.body?.action,
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.get('/sessions/:id/timeline', async (req, res, next) => {
    try {
      const result = await getSessionTimeline({
        actor: req.collabActor,
        sessionId: req.params.id,
        cursor: req.query.cursor || undefined,
        limit: Number.parseInt(String(req.query.limit ?? ''), 10) || 100,
      });
      res.json({ data: result.entries, nextCursor: result.nextCursor,cursor:result.cursor });
    } catch (err) {
      next(err);
    }
  });

  router.post('/runs/:id/wrap-up-preflights', async (req, res, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(req);
      const result = await queueRunCommand({
        actor: req.collabActor,
        runId: req.params.id,
        sessionId: null,
        idempotencyKey,
        kind: 'wrapup_preflight',
        payload: {},
      });
      res.status(result.created ? 202 : 200).json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post('/runs/:id/wrap-ups', async (req, res, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(req);
      const result = await queueRunCommand({
        actor: req.collabActor,
        runId: req.params.id,
        sessionId: null,
        idempotencyKey,
        kind: 'wrapup',
        payload: { preflightId: req.body?.preflightId ?? null, mode: req.body?.mode },
      });
      res.status(result.created ? 202 : 200).json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  const events = async (req, res, next) => {
    try {
      const input = {
        actor: req.collabActor,
        taskId: req.params.id || req.query.taskId || undefined,
        projectId: req.query.projectId || undefined,
        cursor: req.query.cursor || req.headers['last-event-id'] || undefined,
        limit: Number.parseInt(String(req.query.limit ?? ''), 10) || 100,
      };
      const result = await listTaskEvents(input);
      if ((req.headers.accept ?? '').includes('text/event-stream')) {
        res.set({
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.flushHeaders();
        res.write(': connected\n\n');
        let closed = false;
        let timer;
        const close = () => { closed = true; clearTimeout(timer); };
        res.on('close', close);
        const publish = (page) => {
          for (const event of page.events) {
            res.write(`id: ${event.cursor}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`);
          }
          input.cursor = page.nextCursor || input.cursor;
        };
        publish(result);
        const poll = async () => {
          if (closed) return;
          try {
            // Re-run identity, scope and visibility on every delivery. Never
            // retain a membership snapshot for a long-lived connection.
            const page = await listTaskEvents(input);
            if (closed) return;
            publish(page);
            res.write(': heartbeat\n\n');
            timer = setTimeout(poll, 500);
          } catch (err) {
            if (!closed) {
              const event = [401, 403, 404].includes(err.status) ? 'access_revoked' : 'unavailable';
              res.write(`event: ${event}\ndata: {}\n\n`);
              res.end();
            }
            close();
          }
        };
        timer = setTimeout(poll, 500);
        return;
      }
      res.json({ data: result.events, nextCursor: result.nextCursor });
    } catch (err) {
      next(err);
    }
  };
  router.get('/events', events);
  router.get('/tasks/:id/events', events);

  router.post('/tasks/:id/read-cursor', async (req, res, next) => {
    try {
      await markTaskRead({ actor: req.collabActor, taskId: req.params.id, eventId: req.body?.eventId });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.get('/attention', async (req, res, next) => {
    try {
      const result = await listAttention({
        actor: req.collabActor,
        taskId: req.query.taskId || undefined,
        projectId: req.query.projectId || undefined,
        cursor: req.query.cursor || undefined,
        limit: Number.parseInt(String(req.query.limit ?? ''), 10) || 50,
      });
      res.json({ data: result.attention, nextCursor: result.nextCursor });
    } catch (err) {
      next(err);
    }
  });

  router.post('/tasks/:id/comments', async (req, res, next) => {
    try {
      const comment = await createCollabComment({
        actor: req.collabActor,
        taskId: req.params.id,
        body: req.body?.body,
        visibility: req.body?.visibility,
      });
      res.status(201).json({ data: comment });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks/:id/comments', async (req, res, next) => {
    try {
      const result = await listCollabComments({
        actor: req.collabActor,
        taskId: req.params.id,
        cursor: req.query.cursor || undefined,
        limit: Number.parseInt(String(req.query.limit ?? ''), 10) || 50,
      });
      res.json({ data: result.comments, nextCursor: result.nextCursor });
    } catch (err) {
      next(err);
    }
  });

  router.get('/sessions/:id/pending-request', async (req, res, next) => {
    try {
      const pending = await getSessionPendingRequest(req.collabActor, req.params.id);
      res.json({ data: pending });
    } catch (err) {
      next(err);
    }
  });
}
