import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEPLOY_ACTIONS = new Set(['opened', 'reopened', 'synchronize']);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function previewDeployment(event, repository) {
  if (!event || typeof event !== 'object' || !repository || typeof repository !== 'string') {
    throw new Error('Invalid pull request event');
  }
  if (event.repository?.full_name !== repository) {
    throw new Error('Event repository does not match the workflow repository');
  }

  const pullRequest = event.pull_request;
  if (!pullRequest || typeof pullRequest !== 'object') {
    throw new Error('Missing pull request payload');
  }
  if (pullRequest.head?.repo?.full_name !== repository) return null;

  const number = pullRequest.number;
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('Invalid pull request number');
  }

  const headSha = pullRequest.head?.sha;
  if (typeof headSha !== 'string' || !SHA_PATTERN.test(headSha)) {
    throw new Error('Invalid pull request head SHA');
  }

  let operation;
  if (DEPLOY_ACTIONS.has(event.action)) operation = 'deploy';
  else if (event.action === 'closed') operation = 'remove';
  else throw new Error(`Unsupported pull request action: ${String(event.action)}`);

  return {
    operation,
    number,
    projectName: `fluent-flow-preview-${number}`,
    environmentName: `preview-pr-${number}`,
    dashboardHost: `pr-${number}.preview.app.fluentflow.tech`,
    apiHost: `api-pr-${number}.preview.app.fluentflow.tech`,
    headSha,
  };
}

function writeOutput(path, key, value) {
  appendFileSync(path, `${key}=${value}\n`, { encoding: 'utf8' });
}

function runCli() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!eventPath || !repository || !outputPath) {
    throw new Error('GITHUB_EVENT_PATH, GITHUB_REPOSITORY, and GITHUB_OUTPUT are required');
  }

  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const deployment = previewDeployment(event, repository);
  writeOutput(outputPath, 'eligible', deployment ? 'true' : 'false');
  if (!deployment) return;

  writeOutput(outputPath, 'operation', deployment.operation);
  writeOutput(outputPath, 'number', deployment.number);
  writeOutput(outputPath, 'project_name', deployment.projectName);
  writeOutput(outputPath, 'environment_name', deployment.environmentName);
  writeOutput(outputPath, 'dashboard_host', deployment.dashboardHost);
  writeOutput(outputPath, 'api_host', deployment.apiHost);
  writeOutput(outputPath, 'head_sha', deployment.headSha);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath && fileURLToPath(import.meta.url) === entryPath) runCli();
