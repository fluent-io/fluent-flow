
export class NativeProtocolError extends Error {
  /**
   * @param {'line_too_long'|'invalid_json'|'torn_final_line'|'stream_closed'|'control_error'|'control_timeout'|'unknown_response'|'version_unreadable'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'NativeProtocolError';
    this.code = code;
  }
}

const NEWLINE = 0x0a;

/**
 * @param {{ readable: import('node:stream').Readable, writable: import('node:stream').Writable, maxLineBytes?: number }} opts
 * @returns {{ messages: AsyncIterable<object>, send(message: object): Promise<void>, end(): Promise<void>, closed: Promise<{ error: NativeProtocolError|null }>, fail(error: NativeProtocolError): void }}
 */
export function createJsonlChannel({ readable, writable, maxLineBytes = 8 * 1024 * 1024 }) {
  /** @type {object[]} */
  const queue = [];
  /** @type {((value: void) => void) | null} */
  let wake = null;
  let finished = false;
  /** @type {(v: { error: NativeProtocolError|null }) => void} */
  let resolveClosed;
  const closed = new Promise((r) => (resolveClosed = r));
  /** @type {Buffer[]} */
  let pending = [];
  let pendingBytes = 0;

  function finish(error) {
    if (finished) return;
    finished = true;
    pending = [];
    readable.removeListener('data', onData);
    if (error) {
      readable.destroy?.();
      writable.destroy?.();
    }
    resolveClosed({ error });
    wake?.();
  }

  function pushLine(buf) {
    if (buf.length === 0) return true;
    let message;
    try {
      message = JSON.parse(buf.toString('utf8'));
    } catch {
      finish(new NativeProtocolError('invalid_json', 'native stream produced a line that is not JSON'));
      return false;
    }
    queue.push(message);
    wake?.();
    return true;
  }

  function onData(chunk) {
    let buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    while (!finished && buf.length) {
      const idx = buf.indexOf(NEWLINE);
      const part = idx === -1 ? buf : buf.subarray(0, idx);
      if (pendingBytes + part.length > maxLineBytes) {
        finish(new NativeProtocolError('line_too_long', `native line exceeded ${maxLineBytes} bytes`));
        return;
      }
      if (idx === -1) {
        pending.push(part);
        pendingBytes += part.length;
        return;
      }
      const line = pending.length ? Buffer.concat([...pending, part]) : part;
      pending = [];
      pendingBytes = 0;
      if (!pushLine(line)) return;
      buf = buf.subarray(idx + 1);
    }
  }

  readable.on('data', onData);
  readable.on('end', () => {
    if (pendingBytes > 0) finish(new NativeProtocolError('torn_final_line', 'native stream ended mid-line'));
    else finish(null);
  });
  readable.on('close', () => finish(pendingBytes > 0 ? new NativeProtocolError('torn_final_line', 'native stream ended mid-line') : null));
  readable.on('error', () => finish(new NativeProtocolError('stream_closed', 'native stream failed')));
  writable.on('error', () => finish(new NativeProtocolError('stream_closed', 'native input stream failed')));

  const messages = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) {
          yield /** @type {object} */ (queue.shift());
          continue;
        }
        if (finished) return;
        await /** @type {Promise<void>} */ (new Promise((r) => (wake = r)));
        wake = null;
      }
    },
  };

  async function send(message) {
    if (finished || /** @type {any} */ (writable).writableEnded || /** @type {any} */ (writable).destroyed) {
      throw new NativeProtocolError('stream_closed', 'native channel is closed');
    }
    const line = `${JSON.stringify(message)}\n`;
    await new Promise((resolve, reject) => {
      let flushed = false;
      let drained = true;
      const done = () => flushed && drained && resolve(undefined);
      const ok = writable.write(line, (err) => {
        if (err) return reject(new NativeProtocolError('stream_closed', 'native input write failed'));
        flushed = true;
        done();
      });
      if (!ok) {
        drained = false;
        writable.once('drain', () => {
          drained = true;
          done();
        });
      }
    });
  }

  async function end() {
    if (/** @type {any} */ (writable).writableEnded) return;
    await /** @type {Promise<void>} */ (new Promise((resolve) => writable.end(() => resolve())));
  }

  /**
   * @param {NativeProtocolError} error
   */
  function fail(error) {
    finish(error);
  }

  return { messages, send, end, closed, fail };
}
