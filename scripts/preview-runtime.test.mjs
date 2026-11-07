import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  derivePreviewSecret,
  previewComposeArgs,
  previewRuntimeEnvironment,
  runPreviewOperation,
  writePreviewEnvFile,
} from './preview-runtime.mjs';

const deployment = {
  operation: 'deploy',
  number: 122,
  projectName: 'fluent-flow-preview-122',
  environmentName: 'preview-pr-122',
  dashboardHost: 'pr-122.preview.app.fluentflow.tech',
  apiHost: 'api-pr-122.preview.app.fluentflow.tech',
  headSha: 'a'.repeat(40),
};

const credentials = {
  githubAppId: '12345',
  githubAppPrivateKey: 'base64-private-key',
  githubAppWebhookSecret: 'webhook-secret',
  githubClientId: 'client-id',
  githubClientSecret: 'client-secret',
};

test('derives stable distinct secrets for different pull requests and purposes', () => {
  const first = derivePreviewSecret('stack-seed', 122, 'postgres');
  assert.equal(first, derivePreviewSecret('stack-seed', 122, 'postgres'));
  assert.notEqual(first, derivePreviewSecret('stack-seed', 123, 'postgres'));
  assert.notEqual(first, derivePreviewSecret('stack-seed', 122, 'nextauth'));
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('writes a mode-0600 env file without logging values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fluent-flow-preview-test-'));
  const environment = previewRuntimeEnvironment({
    deployment,
    credentials,
    stackSecret: 'stack-seed',
    sourceDir: '/tmp/source',
    edgeNetwork: 'fluent-flow-preview-edge',
  });
  const path = writePreviewEnvFile(directory, environment);

  assert.equal(statSync(path).mode & 0o777, 0o600);
  const body = readFileSync(path, 'utf8');
  assert.match(body, /^PREVIEW_SOURCE_DIR=\/tmp\/source$/m);
  assert.match(body, /^PREVIEW_ROUTER_PREFIX=preview-pr-122$/m);
  assert.doesNotMatch(body, /DATABASE_URL|NEXTAUTH_URL|POSTGRES_PASSWORD/);
});

test('produces deploy arguments bound to the trusted compose file and project', () => {
  assert.deepEqual(
    previewComposeArgs('deploy', {
      envFile: '/tmp/runtime.env',
      projectName: 'fluent-flow-preview-122',
      composeFile: '/trusted/docker-compose.preview.yml',
    }),
    [
      'compose',
      '--env-file',
      '/tmp/runtime.env',
      '--project-name',
      'fluent-flow-preview-122',
      '--file',
      '/trusted/docker-compose.preview.yml',
      'up',
      '--detach',
      '--build',
      '--remove-orphans',
      '--wait',
    ],
  );
});

test('produces idempotent removal arguments with volumes and local images', () => {
  assert.deepEqual(
    previewComposeArgs('remove', {
      envFile: '/tmp/runtime.env',
      projectName: 'fluent-flow-preview-122',
      composeFile: '/trusted/docker-compose.preview.yml',
    }),
    [
      'compose',
      '--env-file',
      '/tmp/runtime.env',
      '--project-name',
      'fluent-flow-preview-122',
      '--file',
      '/trusted/docker-compose.preview.yml',
      'down',
      '--volumes',
      '--remove-orphans',
      '--rmi',
      'local',
    ],
  );
});

test('rejects empty credentials and unsafe project names', () => {
  assert.throws(() => derivePreviewSecret('', 122, 'postgres'), /stack secret/i);
  assert.throws(
    () => previewRuntimeEnvironment({
      deployment,
      credentials: { ...credentials, githubClientSecret: '' },
      stackSecret: 'stack-seed',
      sourceDir: '/tmp/source',
      edgeNetwork: 'fluent-flow-preview-edge',
    }),
    /githubClientSecret/,
  );
  assert.throws(
    () => previewComposeArgs('deploy', {
      envFile: '/tmp/runtime.env',
      projectName: 'fluent-flow-preview-122; rm -rf /',
      composeFile: '/trusted/docker-compose.preview.yml',
    }),
    /project name/i,
  );
});

test('executes a preview operation with array arguments and erases its runtime file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fluent-flow-preview-run-'));
  const calls = [];
  let runtimePath;
  const result = runPreviewOperation({
    deployment,
    credentials,
    stackSecret: 'stack-seed',
    sourceDir: '/tmp/source',
    edgeNetwork: 'fluent-flow-preview-edge',
    composeFile: '/trusted/docker-compose.preview.yml',
    runtimeDir: directory,
    runCommand(command, args) {
      calls.push([command, args]);
      runtimePath = args[2];
      assert.equal(existsSync(runtimePath), true);
      assert.equal(statSync(runtimePath).mode & 0o777, 0o600);
      return { status: 0 };
    },
  });

  assert.equal(result, 0);
  assert.deepEqual(calls[0][1].slice(-2), ['config', '--quiet']);
  assert.deepEqual(calls[1][1].slice(-5), ['up', '--detach', '--build', '--remove-orphans', '--wait']);
  assert.equal(existsSync(runtimePath), false);
});

test('erases the runtime file when Docker fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fluent-flow-preview-run-'));
  let runtimePath;
  assert.throws(
    () => runPreviewOperation({
      deployment,
      credentials,
      stackSecret: 'stack-seed',
      sourceDir: '/tmp/source',
      edgeNetwork: 'fluent-flow-preview-edge',
      composeFile: '/trusted/docker-compose.preview.yml',
      runtimeDir: directory,
      runCommand(_command, args) {
        runtimePath = args[2];
        return { status: 17 };
      },
    }),
    /Docker Compose exited with status 17/,
  );
  assert.equal(existsSync(runtimePath), false);
});
