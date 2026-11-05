
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVIDENCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'evidence');

export function createEvidence({ backend, version, root }) {
  const dir = join(EVIDENCE_ROOT, `${backend}-${version}`);
  const realHome = homedir();
  const sanitize = (value) =>
    JSON.parse(
      JSON.stringify(value ?? null)
        .split(root)
        .join('<probe-root>')
        .split(realHome)
        .join('<real-home>')
        .replace(/\/tmp\/cc-socks\/\d+\.sock/g, '<socket>'),
    );
  /** @type {Record<string, any>} */
  const summary = {};
  return {
    dir,
    sanitize,
    record(id, data) {
      summary[id] = sanitize(data);
    },
    flush() {
      mkdirSync(dir, { recursive: true });
      for (const [id, data] of Object.entries(summary)) {
        writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(data, null, 2)}\n`);
      }
    },
  };
}
