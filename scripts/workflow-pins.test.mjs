import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = ['ci.yml', 'release-agent-server.yml'];

function workflowLines(name) {
  const path = fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url));
  return readFileSync(path, 'utf8').split(/\r?\n/u).map((text, index) => ({ text, line: index + 1 }));
}

function references(name, pattern) {
  return workflowLines(name).flatMap(({ text, line }) => {
    const match = pattern.exec(text);
    return match ? [{ line, value: match[1] }] : [];
  });
}

for (const name of WORKFLOWS) {
  test(`${name} pins every action reference to a full commit SHA`, () => {
    const uses = references(name, /^\s*(?:-\s+)?uses:\s*(\S+)\s*$/u);
    assert.ok(uses.length > 0, `${name} references no actions`);
    for (const { line, value } of uses) {
      assert.match(value, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+@[0-9a-f]{40}$/u, `${name}:${line} uses ${value}`);
    }
  });

  test(`${name} pins every container image to a digest`, () => {
    const images = [
      ...references(name, /^\s*image:\s*(\S+)\s*$/u),
      ...references(name, /docker run\b.*?\s([a-z0-9.-]+(?:\/[a-z0-9._-]+)+:[A-Za-z0-9._-]+(?:@\S+)?)(?:\s|$)/u),
    ];
    assert.ok(images.length > 0, `${name} references no container images`);
    for (const { line, value } of images) {
      assert.match(value, /@sha256:[0-9a-f]{64}$/u, `${name}:${line} references ${value}`);
    }
  });
}
