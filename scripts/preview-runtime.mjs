import { createHmac, randomUUID } from 'node:crypto';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const PROJECT_PATTERN = /^fluent-flow-preview-[1-9]\d*$/;
const HOST_PATTERN = /^(?:api-)?pr-[1-9]\d*\.preview\.app\.fluentflow\.tech$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SAFE_NETWORK_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function requiredText(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} is required and must be a single-line value`);
  }
  return value;
}

export function derivePreviewSecret(stackSecret, number, purpose) {
  requiredText(stackSecret, 'Preview stack secret');
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull request number');
  requiredText(purpose, 'Secret purpose');
  return createHmac('sha256', stackSecret).update(`preview:${number}:${purpose}`).digest('hex');
}

function validateDeployment(deployment) {
  if (!deployment || typeof deployment !== 'object') throw new Error('Preview deployment is required');
  if (!Number.isSafeInteger(deployment.number) || deployment.number < 1) throw new Error('Invalid pull request number');
  if (!PROJECT_PATTERN.test(deployment.projectName)) throw new Error('Invalid preview project name');
  if (!HOST_PATTERN.test(deployment.dashboardHost) || deployment.dashboardHost.startsWith('api-')) {
    throw new Error('Invalid preview dashboard host');
  }
  if (!HOST_PATTERN.test(deployment.apiHost) || !deployment.apiHost.startsWith('api-')) {
    throw new Error('Invalid preview API host');
  }
  if (!SHA_PATTERN.test(deployment.headSha)) throw new Error('Invalid pull request head SHA');
}

export function previewRuntimeEnvironment({ deployment, credentials, stackSecret, sourceDir, edgeNetwork }) {
  validateDeployment(deployment);
  if (!credentials || typeof credentials !== 'object') throw new Error('Preview credentials are required');
  if (!isAbsolute(sourceDir)) throw new Error('Preview source directory must be absolute');
  if (!SAFE_NETWORK_PATTERN.test(edgeNetwork)) throw new Error('Invalid preview edge network');

  const githubAppId = requiredText(credentials.githubAppId, 'githubAppId');
  const githubAppPrivateKey = requiredText(credentials.githubAppPrivateKey, 'githubAppPrivateKey');
  const githubAppWebhookSecret = requiredText(credentials.githubAppWebhookSecret, 'githubAppWebhookSecret');
  const githubClientId = requiredText(credentials.githubClientId, 'githubClientId');
  const githubClientSecret = requiredText(credentials.githubClientSecret, 'githubClientSecret');

  return {
    PREVIEW_SOURCE_DIR: sourceDir,
    PREVIEW_DASHBOARD_HOST: deployment.dashboardHost,
    PREVIEW_API_HOST: deployment.apiHost,
    PREVIEW_ROUTER_PREFIX: `preview-pr-${deployment.number}`,
    PREVIEW_DEPLOY_SHA: deployment.headSha,
    PREVIEW_DATABASE_PASSWORD: derivePreviewSecret(stackSecret, deployment.number, 'postgres'),
    PREVIEW_NEXTAUTH_SECRET: derivePreviewSecret(stackSecret, deployment.number, 'nextauth'),
    PREVIEW_MCP_AUTH_TOKEN: derivePreviewSecret(stackSecret, deployment.number, 'mcp'),
    PREVIEW_COLLAB_AUTH_SECRET: derivePreviewSecret(stackSecret, deployment.number, 'collab-auth'),
    PREVIEW_GITHUB_APP_ID: githubAppId,
    PREVIEW_GITHUB_APP_PRIVATE_KEY: githubAppPrivateKey,
    PREVIEW_GITHUB_APP_WEBHOOK_SECRET: githubAppWebhookSecret,
    PREVIEW_GITHUB_CLIENT_ID: githubClientId,
    PREVIEW_GITHUB_CLIENT_SECRET: githubClientSecret,
    PREVIEW_EDGE_NETWORK: edgeNetwork,
  };
}

export function writePreviewEnvFile(directory, environment) {
  if (!isAbsolute(directory)) throw new Error('Preview runtime directory must be absolute');
  const entries = Object.entries(environment);
  if (entries.length === 0) throw new Error('Preview runtime environment is empty');
  for (const [key, value] of entries) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    requiredText(value, key);
  }

  const path = join(directory, `fluent-flow-preview-${randomUUID()}.env`);
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${entries.map(([key, value]) => `${key}=${value}`).join('\n')}\n`, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  return path;
}

export function previewComposeArgs(operation, { envFile, projectName, composeFile }) {
  if (!['deploy', 'remove'].includes(operation)) throw new Error('Invalid preview operation');
  if (!PROJECT_PATTERN.test(projectName)) throw new Error('Invalid preview project name');
  if (!isAbsolute(envFile) || !isAbsolute(composeFile)) throw new Error('Preview Compose paths must be absolute');

  const base = [
    'compose',
    '--env-file',
    envFile,
    '--project-name',
    projectName,
    '--file',
    composeFile,
  ];
  if (operation === 'deploy') {
    return [...base, 'up', '--detach', '--build', '--remove-orphans', '--wait'];
  }
  return [...base, 'down', '--volumes', '--remove-orphans', '--rmi', 'local'];
}
