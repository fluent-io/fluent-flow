import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./preview-uat-diagnostics.mjs', import.meta.url).pathname;

function runDiagnostics(source) {
  const directory = mkdtempSync(join(tmpdir(), 'preview-uat-diagnostics-'));
  const input = join(directory, 'input.log');
  const output = join(directory, 'output.json');
  writeFileSync(input, source);
  const result = spawnSync(process.execPath, [script, input, output], { encoding: 'utf8' });
  const report = result.status === 0 ? JSON.parse(readFileSync(output, 'utf8')) : null;
  rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return report;
}

test('retains OAuth error context without credentials or callback query values', () => {
  const report = runDiagnostics([
    'request started',
    '[next-auth][error][OAUTH_CALLBACK_ERROR] https://pr-134-preview.fluentflow.tech/api/auth/callback/github?code=authorization-code&state=session-state',
    'client_secret=oauth-secret token=ghp_exampletoken password=preview-password',
    'unrelated successful request',
  ].join('\n'));
  const text = JSON.stringify(report);
  assert.match(text, /OAUTH_CALLBACK_ERROR/u);
  assert.match(text, /https:\/\/pr-134-preview\.fluentflow\.tech\/api\/auth\/callback\/github/u);
  assert.doesNotMatch(text, /authorization-code|session-state|oauth-secret|ghp_exampletoken|preview-password/u);
});

test('returns no diagnostics when the runtime log has no error signal', () => {
  assert.deepEqual(runDiagnostics('ready\nrequest complete\n'), { diagnostics: [] });
});
