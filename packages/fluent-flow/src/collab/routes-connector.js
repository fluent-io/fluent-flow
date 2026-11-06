import { Router } from 'express';
import {
  authenticateHost,
  registerConnector,
  heartbeatConnector,
  pollConnectorCommands,
  ackConnectorCommand,
  submitConnectorObservations,
} from '@fluent-flow/db';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import logger from '../logger.js';

function sendConnectorError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.slice(7) || null;
}

const router = Router();

router.use((req, _res, next) => {
  req.requestId = randomUUID();
  next();
});

router.use(async (req, res, next) => {
  try {
    const token = bearerToken(req);
    if (token === null) {
      return sendConnectorError(res, 401, 'unauthenticated', 'Authentication required.');
    }
    try {
      req.connectorHost = await authenticateHost(token);
    } catch (err) {
      logger.warn({ msg: 'connector auth rejected', path: req.path });
      return sendConnectorError(res, 401, 'unauthenticated', 'Authentication required.');
    }
    next();
  } catch (err) {
    next(err);
  }
});

router.post('/register', async (req, res, next) => {
  try {
    const registration = await registerConnector({
      token: bearerToken(req),
      instanceId: req.body?.instanceId,
      protocolVersion: req.body?.protocolVersion,
      sdkVersion: req.body?.sdkVersion,
      daemonVersion: req.body?.daemonVersion,
      capabilities: req.body?.capabilities,
      catalog: req.body?.catalog,
    });
    res.json({ data: registration });
  } catch (err) {
    next(err);
  }
});

router.post('/heartbeat', async (req, res, next) => {
  try {
    const result = await heartbeatConnector({
      token: bearerToken(req),
      connectorSessionId: req.body?.connectorSessionId,
      leaseEpoch: req.body?.leaseEpoch,
      activeRunIds: req.body?.activeRunIds,
      observedAt: req.body?.observedAt,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

router.post('/poll', async (req, res, next) => {
  const disconnect = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) disconnect.abort();
  };
  res.on('close', onClose);
  if (res.destroyed && !res.writableFinished) disconnect.abort();
  try {
    const result = await pollConnectorCommands({
      token: bearerToken(req),
      connectorSessionId: req.body?.connectorSessionId,
      leaseEpoch: req.body?.leaseEpoch,
      waitMs: req.body?.waitMs,
      limit: req.body?.limit,
      signal: disconnect.signal,
    });
    if (disconnect.signal.aborted) return;
    res.json({ data: result });
  } catch (err) {
    if (disconnect.signal.aborted) {
      const serverFault = !(typeof err?.status === 'number' && err.status < 500);
      logger[serverFault ? 'error' : 'warn']({ msg: 'connector poll failed after client disconnect', error: err.message, ...(serverFault ? { stack: err.stack } : {}) });
      return;
    }
    next(err);
  } finally {
    res.off('close', onClose);
  }
});

router.post('/commands/:id/ack', async (req, res, next) => {
  try {
    const result = await ackConnectorCommand({
      token: bearerToken(req),
      connectorSessionId: req.body?.connectorSessionId,
      leaseEpoch: req.body?.leaseEpoch,
      commandId: req.params.id,
      state: req.body?.state,
      result: req.body?.result,
      errorCode: req.body?.errorCode,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

router.post('/observations', async (req, res, next) => {
  try {
    const result = await submitConnectorObservations({
      token: bearerToken(req),
      connectorSessionId: req.body?.connectorSessionId,
      leaseEpoch: req.body?.leaseEpoch,
      events: req.body?.events,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

router.use((err, req, res, _next) => {
  if (err instanceof ZodError) {
    return sendConnectorError(res, 400, 'malformed', 'Invalid request.', req.requestId);
  }
  const status = typeof err?.status === 'number' ? err.status : 500;
  if (status >= 500) {
    logger.error({ msg: 'connector request failed', error: err.message, stack: err.stack });
  }
  sendConnectorError(res, status, err?.code ?? 'internal_error', status >= 500 ? 'Configuration error. Contact support.' : err?.message ?? 'Request failed.');
});

export default router;
