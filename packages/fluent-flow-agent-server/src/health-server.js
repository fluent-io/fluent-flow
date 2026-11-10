import { createServer } from 'node:http';
import { safeError } from './safe-error.js';

function publicStatus(status) {
  return {
    status: status.status,
    instance_id: status.instance_id,
    provider: status.provider,
    capacity: status.capacity,
    active: status.active,
    online_slots: status.online_slots,
  };
}

function sendJson(response, statusCode, body, headers = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

export function createHealthServer({ getStatus, host, port, log = null }) {
  const server = createServer((request, response) => {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      return;
    }
    let path;
    try {
      path = new URL(request.url ?? '/', 'http://health.local').pathname;
    } catch {
      log?.debug('Health request target rejected');
      sendJson(response, 400, { error: 'Bad request' });
      return;
    }
    if (path !== '/healthz' && path !== '/status') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    try {
      const status = publicStatus(getStatus());
      const statusCode = path === '/healthz' && status.status === 'unhealthy' ? 503 : 200;
      sendJson(response, statusCode, status);
    } catch (error) {
      log?.error('Health status unavailable', { error: safeError(error) });
      sendJson(response, 500, { error: 'Health status unavailable' });
    }
  });

  let startPromise = null;
  let stopPromise = null;

  function onServerError(error) {
    if (!log) throw error;
    log.error('Health server error', { error: safeError(error) });
  }

  function start() {
    if (stopPromise) return Promise.reject(new Error('Health server has stopped.'));
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        server.on('error', onServerError);
        resolve(server.address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (startPromise) {
        try {
          await startPromise;
        } catch (error) {
          log?.warn('Health server stop skipped after failed start', { error: safeError(error) });
          return;
        }
      }
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    })();
    return stopPromise;
  }

  return { start, stop };
}
