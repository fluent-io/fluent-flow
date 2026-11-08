import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

const previewEnvironment = {
  PREVIEW_SOURCE_DIR: root,
  PREVIEW_DASHBOARD_HOST: 'pr-122-preview.fluentflow.tech',
  PREVIEW_API_HOST: 'api-pr-122-preview.fluentflow.tech',
  PREVIEW_ROUTER_PREFIX: 'preview-pr-122',
  PREVIEW_DEPLOY_SHA: 'a'.repeat(40),
  PREVIEW_DATABASE_PASSWORD: 'database-password',
  PREVIEW_NEXTAUTH_SECRET: 'nextauth-secret',
  PREVIEW_GITHUB_APP_ID: '12345',
  PREVIEW_GITHUB_APP_PRIVATE_KEY: 'private-key',
  PREVIEW_GITHUB_APP_WEBHOOK_SECRET: 'webhook-secret',
  PREVIEW_GITHUB_CLIENT_ID: 'client-id',
  PREVIEW_GITHUB_CLIENT_SECRET: 'client-secret',
  PREVIEW_MCP_AUTH_TOKEN: 'mcp-token',
  PREVIEW_COLLAB_AUTH_SECRET: 'collab-secret',
  PREVIEW_EDGE_NETWORK: 'fluent-flow-preview-edge',
};

function render(file, project, environment = {}) {
  const result = spawnSync(
    'docker',
    ['compose', '--project-name', project, '--file', file, 'config', '--format', 'json'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...previewEnvironment, ...environment },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function serviceNetworks(service) {
  return Object.keys(service.networks ?? {}).sort();
}

test('renders an isolated preview application stack', () => {
  const config = render('docker-compose.preview.yml', 'fluent-flow-preview-122');
  assert.deepEqual(Object.keys(config.services).sort(), ['dashboard', 'fluent-flow', 'postgres']);

  for (const service of Object.values(config.services)) {
    assert.equal(service.container_name, undefined);
    assert.equal(service.restart, undefined);
  }
  assert.equal(config.services['fluent-flow'].ports, undefined);
  assert.equal(config.services.dashboard.ports, undefined);
  assert.deepEqual(serviceNetworks(config.services.postgres), ['default']);
  assert.deepEqual(serviceNetworks(config.services['fluent-flow']), ['default', 'preview-edge']);
  assert.deepEqual(serviceNetworks(config.services.dashboard), ['default', 'preview-edge']);

  assert.equal(config.services['fluent-flow'].environment.DEPLOY_SHA, 'a'.repeat(40));
  assert.equal(config.services.dashboard.environment.DEPLOY_SHA, 'a'.repeat(40));
  assert.equal(
    config.services['fluent-flow'].environment.DATABASE_URL,
    'postgres://fluentflow:database-password@postgres:5432/fluentflow',
  );
  assert.equal(
    config.services.dashboard.environment.DATABASE_URL,
    'postgres://fluentflow:database-password@postgres:5432/fluentflow',
  );

  const apiLabels = config.services['fluent-flow'].labels;
  const dashboardLabels = config.services.dashboard.labels;
  assert.equal(
    apiLabels['traefik.http.routers.preview-pr-122-api.rule'],
    'Host(`api-pr-122-preview.fluentflow.tech`)',
  );
  assert.equal(apiLabels['traefik.http.services.preview-pr-122-api.loadbalancer.server.port'], '3847');
  assert.equal(
    dashboardLabels['traefik.http.routers.preview-pr-122-dashboard.rule'],
    'Host(`pr-122-preview.fluentflow.tech`)',
  );
  assert.equal(dashboardLabels['traefik.http.services.preview-pr-122-dashboard.loadbalancer.server.port'], '3000');

  const volumeNames = Object.values(config.volumes).map((volume) => volume.name);
  assert.deepEqual(volumeNames, ['fluent-flow-preview-122_postgres-data']);
  assert.equal(config.networks['preview-edge'].external, true);
  assert.equal(config.networks['preview-edge'].name, 'fluent-flow-preview-edge');
});

test('renders different network and volume identities for concurrent pull requests', () => {
  const first = render('docker-compose.preview.yml', 'fluent-flow-preview-122');
  const second = render('docker-compose.preview.yml', 'fluent-flow-preview-123', {
    PREVIEW_DASHBOARD_HOST: 'pr-123-preview.fluentflow.tech',
    PREVIEW_API_HOST: 'api-pr-123-preview.fluentflow.tech',
    PREVIEW_ROUTER_PREFIX: 'preview-pr-123',
  });

  assert.notEqual(first.networks.default.name, second.networks.default.name);
  assert.notEqual(first.volumes['postgres-data'].name, second.volumes['postgres-data'].name);
  assert.equal(first.networks['preview-edge'].name, second.networks['preview-edge'].name);
});

test('renders a private shared edge from Cloudflare Tunnel to Traefik', () => {
  const config = render('docker-compose.preview-edge.yml', 'fluent-flow-preview-edge', {
    PREVIEW_TUNNEL_TOKEN: 'tunnel-token',
    PREVIEW_WEBHOOK_SECRET: 'webhook-secret',
    PREVIEW_ROUTE_SECRET: 'route-secret',
  });

  assert.deepEqual(Object.keys(config.services).sort(), ['cloudflared', 'preview-webhook-router', 'traefik']);
  assert.equal(config.services.traefik.image, 'traefik:v3.6.6');
  assert.deepEqual(config.services.traefik.healthcheck.test, ['CMD', 'traefik', 'healthcheck', '--ping=true']);
  assert.equal(config.services.cloudflared.depends_on.traefik.condition, 'service_healthy');
  assert.equal(config.services.traefik.ports, undefined);
  assert.equal(config.services.cloudflared.ports, undefined);
  assert.deepEqual(config.services.cloudflared.command, [
    'tunnel',
    '--no-autoupdate',
    '--url',
    'http://traefik:80',
    'run',
  ]);
  assert.equal(config.services.cloudflared.environment.TUNNEL_TOKEN, 'tunnel-token');
  assert.equal(config.networks['preview-edge'].external, true);
  assert.equal(config.networks['preview-edge'].name, 'fluent-flow-preview-edge');
});
test('renders the permanent healthy webhook router without privileged mounts', () => {
  const config = render('docker-compose.preview-edge.yml', 'fluent-flow-preview-edge', {
    PREVIEW_TUNNEL_TOKEN: 'tunnel-token',
    PREVIEW_WEBHOOK_SECRET: 'webhook-secret',
    PREVIEW_ROUTE_SECRET: 'route-secret',
  });
  const router = config.services['preview-webhook-router'];
  assert.ok(router);
  assert.ok(router.healthcheck);
  assert.equal(router.image, undefined);
  assert.equal(router.build.dockerfile, 'scripts/preview-webhook-router/Dockerfile');
  assert.deepEqual(router.depends_on.traefik.condition, 'service_healthy');
  assert.equal(router.ports, undefined);
  assert.deepEqual(router.networks, { 'preview-edge': null });
  assert.deepEqual(router.volumes, [{ type: 'volume', source: 'preview-router-state', target: '/data', volume: {} }]);
  assert.equal(router.environment.PREVIEW_WEBHOOK_SECRET, 'webhook-secret');
  assert.equal(router.environment.PREVIEW_ROUTE_SECRET, 'route-secret');
  assert.equal(router.environment.PREVIEW_GITHUB_APP_PRIVATE_KEY, undefined);
  assert.equal(router.volumes.some((volume) => typeof volume === 'string' && volume.includes('docker.sock')), false);
  assert.equal(router.labels['traefik.http.routers.preview-webhook.rule'], 'Host(`preview-webhooks.fluentflow.tech`)');
  assert.equal(router.labels['traefik.http.services.preview-webhook.loadbalancer.server.port'], '3000');
  assert.deepEqual(config.volumes['preview-router-state'], {
    name: 'fluent-flow-preview-router-state',
  });
});

test('requires both router secrets during Compose interpolation', () => {
  for (const missingSecret of ['PREVIEW_WEBHOOK_SECRET', 'PREVIEW_ROUTE_SECRET']) {
    assert.throws(
      () => render('docker-compose.preview-edge.yml', 'fluent-flow-preview-edge', {
        PREVIEW_TUNNEL_TOKEN: 'tunnel-token',
        PREVIEW_WEBHOOK_SECRET: missingSecret === 'PREVIEW_WEBHOOK_SECRET' ? '' : 'webhook-secret',
        PREVIEW_ROUTE_SECRET: missingSecret === 'PREVIEW_ROUTE_SECRET' ? '' : 'route-secret',
      }),
      /required/,
    );
  }
});
