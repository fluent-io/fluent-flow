import { createHmac, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createArtifactReader } from './connector/artifacts.js';
import { createLogger } from './logger.js';
import { safeError } from './safe-error.js';
import { redactAcpPayload } from './acp/normalize.js';
import { createWorkspacePublisher } from './reporting-workspace.js';

export const REPORTING_MCP_NAME = 'fluent-flow-collaboration';
export const REPORTING_MCP_LAUNCHER = fileURLToPath(new URL('../bin/fluent-flow-reporting-mcp.js', import.meta.url));
export const MAX_CAPTURE_BYTES = 524288;

const MIN_DENY_LENGTH = 8;
const WORKSPACE_KEY = 'workspace';
const CAPTURE_META_KEY = 'fluent-flow/file-capture';

const configSchema = z.object({
  url: z.string().url().refine((value) => /^https?:$/u.test(new URL(value).protocol)),
  credential: z.string().regex(/^ffcl_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/u),
  captureKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  bindingId: z.string().uuid(),
  claimId: z.number().int().positive(),
  workspace: z.string().refine((value) => isAbsolute(value)),
  deny: z.array(z.string()),
});

const reportingSchema = z.object({
  bindingId: z.string().uuid(),
  credential: z.string().min(1),
  captureKey: z.string().min(1),
});

export function reportingMcpUrl(serverUrl) {
  return `${serverUrl.replace(/\/+$/u, '')}/mcp/collab`;
}

export function createReportingMcpDescriptor({ serverUrl, claimId, reporting, workspaceRoot, denyValues = [] }) {
  if (typeof serverUrl !== 'string' || serverUrl.length === 0) throw new Error('Reporting server URL is required');
  if (!Number.isSafeInteger(claimId) || claimId <= 0) throw new Error('Reporting claim is invalid');
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) throw new Error('Reporting workspace must be absolute');
  const binding = reportingSchema.parse(reporting);
  const deny = z.array(z.string()).parse(denyValues.filter((value) => typeof value === 'string' && value.length >= MIN_DENY_LENGTH));
  return {
    type: 'stdio',
    name: REPORTING_MCP_NAME,
    command: process.execPath,
    args: [REPORTING_MCP_LAUNCHER],
    env: [
      { name: 'FLUENT_FLOW_REPORTING_URL', value: reportingMcpUrl(serverUrl) },
      { name: 'FLUENT_FLOW_REPORTING_CREDENTIAL', value: binding.credential },
      { name: 'FLUENT_FLOW_REPORTING_CAPTURE_KEY', value: binding.captureKey },
      { name: 'FLUENT_FLOW_REPORTING_BINDING_ID', value: binding.bindingId },
      { name: 'FLUENT_FLOW_REPORTING_CLAIM_ID', value: String(claimId) },
      { name: 'FLUENT_FLOW_REPORTING_WORKSPACE', value: workspaceRoot },
      { name: 'FLUENT_FLOW_REPORTING_DENY', value: JSON.stringify(deny) },
    ],
  };
}

export function readReportingMcpConfig(env) {
  let deny;
  try {
    deny = JSON.parse(env.FLUENT_FLOW_REPORTING_DENY ?? '[]');
  } catch {
    throw new Error('Reporting helper configuration is invalid');
  }
  const parsed = configSchema.safeParse({
    url: env.FLUENT_FLOW_REPORTING_URL,
    credential: env.FLUENT_FLOW_REPORTING_CREDENTIAL,
    captureKey: env.FLUENT_FLOW_REPORTING_CAPTURE_KEY,
    bindingId: env.FLUENT_FLOW_REPORTING_BINDING_ID,
    claimId: Number(env.FLUENT_FLOW_REPORTING_CLAIM_ID),
    workspace: env.FLUENT_FLOW_REPORTING_WORKSPACE,
    deny,
  });
  if (!parsed.success) throw new Error('Reporting helper configuration is invalid');
  return parsed.data;
}

function toolError(error) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
}

const unavailable = () => toolError({ code: 'reporting_unavailable', message: 'Reporting is unavailable.' });

function denyList(config) {
  const values = new Set([config.credential, config.captureKey, config.workspace, ...config.deny]);
  try {
    values.add(realpathSync(config.workspace));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return [...values].filter((value) => value.length >= MIN_DENY_LENGTH).map((value) => Buffer.from(value, 'utf8'));
}

function normalizedReference(workspace, reference) {
  return relative(workspace, resolve(workspace, reference)).split(sep).join('/');
}

export function captureProof({ config, captureId, name, direction, reference, mime, sizeBytes, sha256, contentBase64 }) {
  const material = JSON.stringify([
    'fluent-flow:file-capture:v1',
    config.bindingId,
    config.claimId,
    captureId,
    name,
    'file',
    direction,
    reference,
    mime,
    sizeBytes,
    sha256,
  ]);
  return {
    version: 1,
    bindingId: config.bindingId,
    captureId,
    mime,
    sizeBytes,
    sha256,
    contentBase64,
    hmac: createHmac('sha256', Buffer.from(config.captureKey, 'base64url')).update(material).digest('base64url'),
  };
}

function reportingConnection(config) {
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: { authorization: `Bearer ${config.credential}` } },
    reconnectionOptions: { initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
  });
  const client = new Client({ name: 'fluent-flow-reporting-mcp', version: '1.0.0' });
  return { client, transport };
}

export async function reportFinalWorkspace(descriptor, { signal = undefined, requirePullRequest = false } = {}) {
  const config = readReportingMcpConfig(Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value])));
  const { client, transport } = reportingConnection(config);
  const requestOptions = { timeout: 10_000, signal };
  try {
    await client.connect(transport, requestOptions);
    await createWorkspacePublisher({ config, getClient: async () => client, requestOptions, signal }).publish({ final: true });
    if (requirePullRequest) {
      const result = z.object({
        isError: z.boolean().optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      }).parse(await client.callTool({ name: 'collaboration_link_pull_request', arguments: {} }, undefined, requestOptions));
      if (result.isError) throw new Error('Native pull request could not be finalized');
      const text = result.content.find(item => item.type === 'text')?.text;
      const link = z.object({
        id: z.string().uuid(),
        verified: z.literal(true),
        producerClaimId: z.number().int().positive(),
      }).parse(JSON.parse(text ?? 'null'));
      if (link.producerClaimId !== config.claimId) throw new Error('Native pull request producer does not match');
    }
  } catch (error) {
    throw new Error('Workspace state could not be finalized', { cause: error });
  } finally {
    await client.close();
  }
}

function readReportingTask(result) {
  const parsed = z.object({ isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).parse(result);
  if (parsed.isError) throw new Error('Reporting purpose is unavailable');
  const content = parsed.content.find(item => item.type === 'text' && typeof item.text === 'string');
  if (!content?.text) throw new Error('Reporting purpose is unavailable');
  return z.discriminatedUnion('reportingRole', [
    z.object({ reportingRole: z.literal('work') }),
    z.object({ reportingRole: z.literal('summary'), summary: z.object({ reported: z.boolean() }) }),
  ]).parse(JSON.parse(content.text));
}

export async function summaryPublished(descriptor, { signal = undefined } = {}) {
  const config = readReportingMcpConfig(Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value])));
  const { client, transport } = reportingConnection(config);
  const requestOptions = { timeout: 10_000, signal };
  try {
    await client.connect(transport, requestOptions);
    const result = await client.callTool({ name: 'collaboration_get_task', arguments: {} }, undefined, requestOptions);
    const task = readReportingTask(result);
    return task.reportingRole === 'summary' && task.summary.reported;
  } finally {
    await client.close();
  }
}

export async function runReportingMcpHelper({ env = process.env, stdin = process.stdin, stdout = process.stdout, signals = process } = {}) {
  const config = readReportingMcpConfig(env);
  const reader = createArtifactReader({ roots: { [WORKSPACE_KEY]: config.workspace }, limits: { maxBytes: MAX_CAPTURE_BYTES } });
  const denied = denyList(config);
  const privateValues = denied.map((value) => value.toString('utf8'));
  const log = createLogger(false, 'info', process.stderr);
  let upstream = null;
  let activeClient = null;
  let closing = false;
  const observerController = new AbortController();
  let finish;
  const finished = new Promise((resolvePromise) => { finish = resolvePromise; });

  function logFailure(error) {
    let message = safeError(error);
    for (const value of denied) message = message.split(value.toString('utf8')).join('[REDACTED]');
    log.error('Reporting transport failed', { event: 'reporting_transport_failed', claimId: config.claimId, error: message });
  }

  async function connectUpstream() {
    if (closing) throw new Error('Reporting helper is closing');
    const { client, transport } = reportingConnection(config);
    activeClient = client;
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close();
      if (activeClient === client) {
        activeClient = null;
        upstream = null;
      }
      throw error;
    }
    return client;
  }

  function upstreamClient() {
    if (upstream === null) upstream = connectUpstream();
    return upstream;
  }
  const workspace = createWorkspacePublisher({ config, getClient: upstreamClient, signal: observerController.signal });
  let callTail = Promise.resolve();
  let purpose = null;

  async function resolvePurpose() {
    if (purpose !== null) return purpose;
    const client = await upstreamClient();
    const result = await client.callTool({ name: 'collaboration_get_task', arguments: {} });
    purpose = readReportingTask(result).reportingRole;
    return purpose;
  }

  async function forward(params) {
    let client;
    try {
      client = await upstreamClient();
      if (closing) return unavailable();
      return redactAcpPayload(await client.callTool(params), privateValues);
    } catch (error) {
      if (!closing) logFailure(error);
      return unavailable();
    }
  }

  async function reportFile(args) {
    const reference = typeof args.reference === 'string' ? args.reference : '';
    const read = reader.read({ repositoryKey: WORKSPACE_KEY, reference });
    if (read.status !== 'available') {
      return toolError({ code: 'capture_unavailable', reason: read.reason, message: 'The file could not be captured.' });
    }
    const content = Buffer.from(read.contentBase64, 'base64');
    const normalized = normalizedReference(config.workspace, reference);
    const metadata = Buffer.from(normalized, 'utf8');
    if (denied.some((value) => content.includes(value) || metadata.includes(value))) {
      return toolError({ code: 'capture_rejected', message: 'The file contains private data and was not captured.' });
    }
    const direction = args.direction === 'input' ? 'input' : 'output';
    const name = redactAcpPayload(args.name, privateValues);
    const proof = captureProof({
      config,
      captureId: randomUUID(),
      name,
      direction,
      reference: normalized,
      mime: read.mediaType,
      sizeBytes: read.sizeBytes,
      sha256: read.sha256,
      contentBase64: read.contentBase64,
    });
    return forward({
      name: 'collaboration_add_artifact',
      arguments: { name, kind: 'file', direction, reference: normalized, mediaType: read.mediaType },
      _meta: { [CAPTURE_META_KEY]: proof },
    });
  }

  const server = new Server({ name: 'fluent-flow-reporting-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    try {
      const client = await upstreamClient();
      return await client.listTools(request.params);
    } catch (error) {
      if (!closing) logFailure(error);
      throw new McpError(ErrorCode.InternalError, 'Reporting is unavailable.');
    }
  });
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const operation = callTail.then(async () => {
      try {
        if (closing) return unavailable();
        const role = await resolvePurpose();
        if (role === 'summary') {
          if (request.params.name === 'collaboration_report_workspace') return toolError({ code: 'summary_workspace_unsupported', message: 'Workspace reporting is unavailable for summary work.' });
          if (request.params.name === 'collaboration_add_artifact') return toolError({ code: 'capture_unavailable', message: 'File capture is unavailable for summary work.' });
          return forward(redactAcpPayload({ name: request.params.name, arguments: request.params.arguments ?? {} }, privateValues));
        }
        const observation = await workspace.publish();
        if (closing) return unavailable();
        if (request.params.name === 'collaboration_report_workspace') return { content: [{ type: 'text', text: JSON.stringify(observation) }] };
        const args = request.params.arguments ?? {};
        if (request.params.name === 'collaboration_add_artifact' && args.kind === 'file') return reportFile(args);
        return forward(redactAcpPayload({ name: request.params.name, arguments: args }, privateValues));
      } catch (error) {
        if (!closing) logFailure(error);
        return unavailable();
      }
    });
    callTail = operation.then(() => undefined);
    return operation;
  });

  async function shutdown() {
    if (closing) return;
    closing = true;
    observerController.abort();
    const client = activeClient;
    activeClient = null;
    upstream = null;
    const results = await Promise.allSettled([
      client ? client.close() : Promise.resolve(),
      server.close(),
    ]);
    stdin.removeListener('end', shutdown);
    stdin.removeListener('close', shutdown);
    signals.removeListener('SIGTERM', shutdown);
    signals.removeListener('SIGINT', shutdown);
    for (const result of results) if (result.status === 'rejected') logFailure(result.reason);
    finish(results.every((result) => result.status === 'fulfilled'));
  }

  stdin.once('end', shutdown);
  stdin.once('close', shutdown);
  signals.once('SIGTERM', shutdown);
  signals.once('SIGINT', shutdown);
  server.onclose = () => { void shutdown(); };
  await server.connect(new StdioServerTransport(stdin, stdout));
  return finished;
}
