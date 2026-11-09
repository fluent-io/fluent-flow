import { access, readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

function unscopedName(name) {
  return name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
}

function binTarget(target) {
  return posix.normalize(target);
}

function resolveNpxBin(pkg) {
  const targets = Object.entries(pkg.bin).map(([name, target]) => [name, binTarget(target)]);
  if (new Set(targets.map(([, target]) => target)).size === 1) return targets[0][0];
  const named = targets.find(([name]) => name === unscopedName(pkg.name));
  return named ? named[0] : undefined;
}

describe('package manifest npx bin resolution', () => {
  it('derives the bin npx runs for the scoped package name from the unscoped name', () => {
    expect(manifest.name).toBe('@fluent-flow/agent-server');
    expect(unscopedName(manifest.name)).toBe('agent-server');
  });

  it('exposes a bin named like the unscoped package name', () => {
    expect(Object.keys(manifest.bin)).toContain(unscopedName(manifest.name));
  });

  it('points the unscoped-name bin at the same file as fluent-flow-agent-server', () => {
    const unscoped = unscopedName(manifest.name);

    expect(manifest.bin['fluent-flow-agent-server']).toBeDefined();
    expect(manifest.bin[unscoped]).toBeDefined();
    expect(binTarget(manifest.bin[unscoped])).toBe(binTarget(manifest.bin['fluent-flow-agent-server']));
  });

  it('lets npx resolve a runnable bin instead of failing for a multi-bin package', () => {
    const resolved = resolveNpxBin(manifest);

    expect(resolved).toBeDefined();
    expect(binTarget(manifest.bin[resolved])).toBe('bin/fluent-flow-agent-server.js');
  });

  it('keeps the connector bin on its own entry point', () => {
    expect(binTarget(manifest.bin['fluent-flow-connector'])).toBe('bin/fluent-flow-connector.js');
    expect(binTarget(manifest.bin['fluent-flow-connector'])).not.toBe(
      binTarget(manifest.bin['fluent-flow-agent-server']),
    );
  });

  it('points every bin at a file that exists in the package', async () => {
    for (const target of Object.values(manifest.bin)) {
      await expect(access(new URL(target, `file://${packageRoot}`))).resolves.toBeUndefined();
    }
  });
});
