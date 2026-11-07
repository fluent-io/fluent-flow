import assert from 'node:assert/strict';
import test from 'node:test';
import { previewDeployment } from './preview-deployment.mjs';

const repository = 'fluent-io/fluent-flow';

function pullRequestEvent({ action = 'opened', number = 122, headRepository = repository, headSha = 'a'.repeat(40) } = {}) {
  return {
    action,
    pull_request: {
      number,
      head: {
        repo: headRepository ? { full_name: headRepository } : null,
        sha: headSha,
      },
    },
    repository: { full_name: repository },
  };
}

test('maps same-repository opened pull request to an isolated deployment', () => {
  assert.deepEqual(previewDeployment(pullRequestEvent(), repository), {
    operation: 'deploy',
    number: 122,
    projectName: 'fluent-flow-preview-122',
    environmentName: 'preview-pr-122',
    dashboardHost: 'pr-122-preview.fluentflow.tech',
    apiHost: 'api-pr-122-preview.fluentflow.tech',
    headSha: 'a'.repeat(40),
  });
});

test('maps same-repository closed pull request to removal without requiring a live branch', () => {
  assert.deepEqual(previewDeployment(pullRequestEvent({ action: 'closed', headSha: 'b'.repeat(40) }), repository), {
    operation: 'remove',
    number: 122,
    projectName: 'fluent-flow-preview-122',
    environmentName: 'preview-pr-122',
    dashboardHost: 'pr-122-preview.fluentflow.tech',
    apiHost: 'api-pr-122-preview.fluentflow.tech',
    headSha: 'b'.repeat(40),
  });
});

test('rejects a fork before producing deployment identity', () => {
  assert.equal(previewDeployment(pullRequestEvent({ headRepository: 'someone/fluent-flow' }), repository), null);
});

test('rejects unsupported pull request actions', () => {
  assert.throws(
    () => previewDeployment(pullRequestEvent({ action: 'labeled' }), repository),
    /Unsupported pull request action/,
  );
});

test('rejects invalid pull request numbers and missing head SHAs', () => {
  for (const number of [0, -1, 1.5, '122']) {
    assert.throws(() => previewDeployment(pullRequestEvent({ number }), repository), /Invalid pull request number/);
  }
  for (const headSha of ['', null, 'not-a-sha']) {
    assert.throws(() => previewDeployment(pullRequestEvent({ headSha }), repository), /Invalid pull request head SHA/);
  }
});
