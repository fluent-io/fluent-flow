
import http from 'node:http';

export async function startDenyProxy() {
  /** @type {string[]} */
  const attempts = [];
  const server = http.createServer((req, res) => {
    let target = req.headers.host ?? 'unknown';
    try {
      const u = new URL(req.url ?? '', `http://${target}`);
      target = `${u.hostname}:${u.port || 80}`;
    } catch {
    }
    attempts.push(target);
    res.writeHead(403).end();
  });
  server.on('connect', (req, socket) => {
    attempts.push(req.url ?? 'unknown');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    attempts,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}
