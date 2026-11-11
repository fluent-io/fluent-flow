import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  Capability,
  ClaimExecution,
  ClaimExecutionBadge,
  ClaimExecutionEvent,
  ClaimExecutionRequest,
  MeResponse,
} from '@/lib/collab/types';
import { TaskClaimExecutionTab } from '@/components/collab/task-claim-execution-tab';
import type { TaskDetail } from '@/components/collab/task-detail';
import {
  createClaimEventState,
  reduceClaimEvents,
} from '@/lib/collab/claim-events';

const meMock = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('@/lib/collab/use-me', () => ({
  useMe: () => ({ me: meMock.value, error: null, loading: false, denied: false, reload: vi.fn() }),
  capabilitiesFor: (me: MeResponse | null, projectId: string) => me?.capabilities[projectId] ?? [],
}));


const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const createdAt = '2026-11-06T12:00:00.000Z';
const allCapabilities: Capability[] = ['task.read', 'internal.read', 'run.start', 'run.steer', 'run.cancel'];

const detail: TaskDetail = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  title: 'Implement claim execution',
  description: '',
  status: 'in_progress',
  priority: 'normal',
  assigneeId: null,
  version: 3,
  position: '1000',
  blockedReason: null,
  createdAt,
  updatedAt: createdAt,
  capabilities: allCapabilities,
};

const me: MeResponse = {
  principal: {
    id: 'principal-1',
    displayName: 'Operator',
    email: 'operator@example.test',
    userId: null,
    disabledAt: null,
    sessionVersion: 1,
  },
  workspaces: [{
    id: 'workspace-1',
    name: 'Workspace',
    projects: [{
      id: PROJECT_ID,
      workspaceId: 'workspace-1',
      name: 'Project',
      version: 1,
      boardVersion: 1,
      executionDefaults: null,
    }],
  }],
  capabilities: { [PROJECT_ID]: allCapabilities },
  workspaceCapabilities: {},
};

type ClaimFixture = Omit<ClaimExecutionBadge, 'claimType'> & { claimType: 'spec' | 'build' };
type FullClaimFixture = Omit<ClaimExecution, 'claimType'> & { claimType: 'spec' | 'build' };


function claim(status = 'claimed', overrides: Partial<ClaimFixture> = {}): ClaimFixture {
  return {
    id: 41,
    taskId: TASK_ID,
    claimType: 'spec',
    attempt: 1,
    status,
    rootClaimId: 41,
    createdAt,
    completedAt: null,
    ...overrides,
  };
}

function fullClaim(value: ClaimFixture): FullClaimFixture {
  return {
    ...value,
    projectId: PROJECT_ID,
    repo: 'acme/fluent-flow',
    prNumber: 127,
    sessionId: value.status === 'claimed' ? 9 : null,
    payload: { branch: 'feature/acp-panel', instructions: 'Keep the panel isolated.' },
    headSha: null,
  };
}

type EventFixture = ClaimExecutionEvent;

function event(seq: number, kind: string, raw: Record<string, unknown>, entity?: { type: string; id: string }): EventFixture {
  return {
    seq,
    kind,
    payload: { claimId: 41, sessionId: 'session-1', raw, ...(entity ? { entity } : {}) },
    createdAt,
  };
}

interface RequestRecord {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}
type ClaimRequestFixture = Omit<ClaimExecutionRequest, 'payload'> & {
  payload: Record<string, unknown>;
};


interface ApiState {
  claims: ClaimFixture[];
  details: Map<number, FullClaimFixture>;
  events: EventFixture[];
  requests: ClaimRequestFixture[];
  denied: boolean;
  privateDenied: boolean;
  listError: boolean;
  eventError: boolean;
  commandResponses: Array<{ status: number; payload: unknown }>;
  startResponses: Array<{ status: number; payload: unknown }>;
  records: RequestRecord[];
  listPages?: Record<string, { data: ClaimFixture[]; nextCursor: string | null }>;
  eventPages?: Record<string, { data: EventFixture[]; nextCursor: string | null }>;
}

let api: ApiState;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function error(status: number, code: string): Response {
  return json({ error: { code, message: 'Private backend detail must not be shown.', requestId: 'request-1' } }, status);
}

function queryCursor(url: string): string {
  return new URL(url, 'http://dashboard.test').searchParams.get('cursor') ?? '';
}

async function fetchStub(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
  api.records.push({ url, method, headers, body });

  if (api.denied) return error(403, 'forbidden');
  if (api.privateDenied && url.includes('/claim-executions/') && !url.includes(`/tasks/${TASK_ID}/claim-executions`)) return error(403, 'forbidden');
  if (url.includes(`/tasks/${TASK_ID}/claim-executions`) && method === 'GET') {
    if (api.listError) return error(500, 'internal_error');
    const page = api.listPages?.[queryCursor(url)];
    return json(page ?? { data: api.claims, nextCursor: null });
  }
  if (url.endsWith(`/tasks/${TASK_ID}/claim-executions`) && method === 'POST') {
    const response = api.startResponses.shift();
    return response ? json(response.payload, response.status) : json({ data: { claim: fullClaim(claim('pending')), created: true } }, 202);
  }
  const detailMatch = url.match(/\/claim-executions\/(\d+)$/);
  if (detailMatch && method === 'GET') {
    const id = Number(detailMatch[1]);
    return json({ data: api.details.get(id) ?? fullClaim(api.claims.find((item) => item.id === id) ?? claim()) });
  }
  if (url.includes('/events?') && method === 'GET') {
    if (api.eventError) return error(500, 'internal_error');
    const page = api.eventPages?.[queryCursor(url)];
    return json(page ?? { data: api.events, nextCursor: null });
  }
  if (url.includes('/requests?') && method === 'GET') {
    return json({ data: api.requests, nextCursor: null });
  }
  if (url.endsWith('/commands') && method === 'POST') {
    const response = api.commandResponses.shift();
    let kind = 'unknown';
    if (body && typeof body === 'object' && 'kind' in body && typeof body.kind === 'string') kind = body.kind;
    return response ? json(response.payload, response.status) : json({ data: { commandId: 1, kind, status: 'pending', created: true } }, 202);
  }
  throw new Error(`Unhandled request: ${method} ${url}`);
}

function renderPanel(task: TaskDetail = detail) {
  return render(<TaskClaimExecutionTab detail={task} reload={vi.fn(async () => {})} />);
}

async function waitForClaim(label = /spec.*attempt 1/i) {
  return screen.findByRole('button', { name: label });
}

function commandRecords(kind: string): RequestRecord[] {
  return api.records.filter((record) => {
    if (record.method !== 'POST' || !record.body || typeof record.body !== 'object' || !('kind' in record.body)) return false;
    return record.body.kind === kind;
  });
}

function stubUniqueKeys() {
  let sequence = 0;
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`),
  });
}

beforeEach(() => {
  meMock.value = me;
  const initialClaim = claim();
  api = {
    claims: [initialClaim],
    details: new Map([[initialClaim.id, fullClaim(initialClaim)]]),
    events: [],
    requests: [],
    denied: false,
    privateDenied: false,
    listError: false,
    eventError: false,
    commandResponses: [],
    startResponses: [],
    records: [],
  };
  vi.stubGlobal('fetch', vi.fn(fetchStub));
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => '00000000-0000-4000-8000-000000000001') });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('claim event reduction', () => {
  it('creates a message from a leading chunk, replaces it with a full snapshot, and updates it without moving the row', () => {
    const input = [
      event(1, 'agent_message', { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'partial' } }, { type: 'agent_message', id: 'm1' }),
      event(2, 'tool_call', { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Inspect', status: 'in_progress' }, { type: 'tool_call', id: 't1' }),
      event(3, 'agent_message', { sessionUpdate: 'agent_message', messageId: 'm1', content: [{ type: 'text', text: 'complete' }] }, { type: 'agent_message', id: 'm1' }),
      event(4, 'agent_message', { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: ' tail' } }, { type: 'agent_message', id: 'm1' }),
    ];

    const state = reduceClaimEvents(createClaimEventState(), input);

    expect(state.entities.map((entity) => entity.key)).toEqual(['agent_message:m1', 'tool_call:t1']);
    expect(state.entities[0]).toMatchObject({
      key: 'agent_message:m1',
      content: [{ type: 'text', text: 'complete' }, { type: 'text', text: ' tail' }],
    });
  });

  it('applies tool patches and chunks without resetting omitted fields', () => {
    const state = reduceClaimEvents(createClaimEventState(), [
      event(1, 'tool_output', { sessionUpdate: 'tool_call_content_chunk', toolCallId: 'tool-1', content: { type: 'content', content: { type: 'text', text: 'before' } } }, { type: 'tool_call', id: 'tool-1' }),
      event(2, 'tool_call', { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', name: 'shell', status: 'in_progress', kind: 'execute', _meta: { source: 'runner' } }, { type: 'tool_call', id: 'tool-1' }),
      event(3, 'tool_call', { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'Build', _meta: { source: null, step: 2 } }, { type: 'tool_call', id: 'tool-1' }),
    ]);

    expect(state.entities).toHaveLength(1);
    expect(state.entities[0]).toMatchObject({
      key: 'tool_call:tool-1',
      name: 'shell',
      title: 'Build',
      kind: 'execute',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'before' } }],
      meta: { step: 2 },
    });
  });

  it('supports both real and legacy plan and notice variants', () => {
    const state = reduceClaimEvents(createClaimEventState(), [
      event(1, 'plan', { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'real-plan', entries: [{ content: 'Ship it', priority: 'high', status: 'in_progress' }] } }),
      event(2, 'plan', { sessionUpdate: 'plan_update', planId: 'legacy-plan', content: { entries: [{ content: 'Verify it', status: 'pending' }] } }, { type: 'plan', id: 'legacy-plan' }),
      event(3, 'notice', { sessionUpdate: 'notice', severity: 'warning', title: 'Attention', description: 'Approval needed' }),
      event(4, 'notice', { sessionUpdate: 'notice', level: 'error', message: 'Legacy warning' }),
    ]);

    expect(state.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'plan:real-plan', entries: [expect.objectContaining({ content: 'Ship it', status: 'in_progress' })] }),
      expect.objectContaining({ key: 'plan:legacy-plan', entries: [expect.objectContaining({ content: 'Verify it', status: 'pending' })] }),
    ]));
    expect(state.notices).toEqual([
      expect.objectContaining({ severity: 'warning', title: 'Attention', description: 'Approval needed' }),
      expect.objectContaining({ severity: 'error', title: 'Legacy warning' }),
    ]);
  });

  it('isolates malformed events and preserves an escaped bounded unknown row', () => {
    const malformed = { seq: 2, kind: 'agent_message', payload: null, createdAt } as EventFixture;
    const state = reduceClaimEvents(createClaimEventState(), [
      event(1, 'state', { sessionUpdate: 'state_update', state: 'running' }),
      malformed,
      event(3, 'unknown', { sessionUpdate: '_vendor_progress', html: '<script>remote()</script>', detail: 'x'.repeat(3000) }),
      event(4, 'state', { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }),
    ]);

    expect(state.runnerState).toEqual({ state: 'idle', stopReason: 'end_turn' });
    expect(state.unknown).toHaveLength(1);
    expect(state.unknown[0]).toMatchObject({ name: '_vendor_progress' });
    expect(state.unknown[0].text.length).toBeLessThanOrEqual(2001);
    expect(state.lastSeq).toBe(4);
  });

  it('keeps only the final 64 KiB of terminal bytes and strips terminal controls', () => {
    const prefix = 'discard-me-'.repeat(7000);
    const suffix = '\u001b[31mSAFE-TAIL\u001b[0m\u0007';
    const encoded = btoa(prefix + suffix);
    const state = reduceClaimEvents(createClaimEventState(), [
      event(1, 'terminal_output', { sessionUpdate: 'terminal_output_chunk', terminalId: 'term-1', data: encoded }, { type: 'terminal', id: 'term-1' }),
    ]);
    const terminal = state.entities.find((entity) => entity.key === 'terminal:term-1');

    expect(terminal).toMatchObject({ truncated: true });
    expect(new TextEncoder().encode(String(terminal?.output)).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(String(terminal?.output)).toContain('SAFE-TAIL');
    expect(String(terminal?.output)).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\u001b\[/);
  });

  it('reassembles UTF-8 characters and ANSI controls split across terminal chunks', () => {
    const encode = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
    const state = reduceClaimEvents(createClaimEventState(), [
      event(1, 'terminal_output', { sessionUpdate: 'terminal_output_chunk', terminalId: 'term-split', data: encode([0x1b, 0x5b, 0x33]) }, { type: 'terminal', id: 'term-split' }),
      event(2, 'terminal_output', { sessionUpdate: 'terminal_output_chunk', terminalId: 'term-split', data: encode([0x31, 0x6d, 0x63, 0x61, 0x66, 0xc3]) }, { type: 'terminal', id: 'term-split' }),
      event(3, 'terminal_output', { sessionUpdate: 'terminal_output_chunk', terminalId: 'term-split', data: encode([0xa9, 0x1b, 0x5b]) }, { type: 'terminal', id: 'term-split' }),
      event(4, 'terminal_output', { sessionUpdate: 'terminal_output_chunk', terminalId: 'term-split', data: encode([0x30, 0x6d]) }, { type: 'terminal', id: 'term-split' }),
    ]);
    const terminal = state.entities.find((entity) => entity.key === 'terminal:term-split');

    expect(terminal?.output).toBe('café');
    expect(String(terminal?.output)).not.toContain('\uFFFD');
    expect(String(terminal?.output)).not.toMatch(/\[(?:3|31|0)m/);
  });

  it('ignores replayed sequences while accepting later updates', () => {
    const first = reduceClaimEvents(createClaimEventState(), [event(1, 'state', { sessionUpdate: 'state_update', state: 'running' })]);
    const replayed = reduceClaimEvents(first, [
      event(1, 'state', { sessionUpdate: 'state_update', state: 'idle' }),
      event(2, 'state', { sessionUpdate: 'state_update', state: 'requires_action' }),
    ]);

    expect(replayed.runnerState).toEqual({ state: 'requires_action' });
    expect(replayed.lastSeq).toBe(2);
  });
});

describe('claim execution states and polling', () => {
  it('shows loading, an empty state, and a generic list failure distinctly', async () => {
    const pending = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const first = renderPanel();
    expect(screen.getByRole('status').textContent).toMatch(/loading executions/i);
    pending.resolve(json({ data: [], nextCursor: null }));
    expect(await screen.findByText(/no claim executions yet/i)).toBeTruthy();
    first.unmount();

    api.listError = true;
    vi.stubGlobal('fetch', vi.fn(fetchStub));
    renderPanel();
    expect((await screen.findByRole('alert')).textContent).toMatch(/executions are temporarily unavailable/i);
    expect(screen.queryByText(/private backend detail/i)).toBeNull();
  });

  it.each([
    ['pending', 'Pending'],
    ['claimed', 'Claimed'],
    ['failed', 'Failed'],
  ])('renders the %s claim status', async (status, label) => {
    const value = claim(status);
    api.claims = [value];
    api.details.set(value.id, fullClaim(value));
    renderPanel();

    await waitForClaim();
    expect(screen.getByText(label, { selector: '[data-claim-status]' })).toBeTruthy();
  });

  it.each([
    ['running', 'Streaming'],
    ['idle', 'Idle'],
  ])('combines a claimed row with the latest %s runner state', async (state, label) => {
    api.events = [event(1, 'state', { sessionUpdate: 'state_update', state })];
    renderPanel();

    await waitForClaim();
    expect(await screen.findByText(label, { selector: '[data-runner-state]' })).toBeTruthy();
  });

  it('omits an empty cursor from initial collection requests', async () => {
    renderPanel();
    await waitForClaim();
    await screen.findByRole('log');

    const collectionReads = api.records.filter((record) =>
      record.method === 'GET'
      && (record.url.includes('/claim-executions?') || record.url.includes('/events?') || record.url.includes('/requests?')));
    expect(collectionReads.length).toBeGreaterThan(0);
    expect(collectionReads.every((record) => !record.url.includes('cursor='))).toBe(true);
  });

  it('walks claim and event pages and preserves stable event rows', async () => {
    const firstClaim = claim('claimed');
    const secondClaim = claim('completed', { id: 42, claimType: 'build', attempt: 2, rootClaimId: 41, completedAt: createdAt });
    api.listPages = {
      '': { data: [firstClaim], nextCursor: 'claim-page-2' },
      'claim-page-2': { data: [secondClaim], nextCursor: null },
    };
    api.eventPages = {
      '': { data: [event(1, 'agent_message', { sessionUpdate: 'agent_message', messageId: 'm1', content: [{ type: 'text', text: 'first page' }] }, { type: 'agent_message', id: 'm1' })], nextCursor: 'event-page-2' },
      'event-page-2': { data: [event(2, 'agent_message', { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: ' second page' } }, { type: 'agent_message', id: 'm1' })], nextCursor: null },
    };
    renderPanel();

    expect(await screen.findByRole('button', { name: /build.*attempt 2/i })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('log').textContent).toMatch(/first page\s+second page/i));
    expect(api.records.some((record) => record.url.includes('cursor=claim-page-2'))).toBe(true);
    expect(api.records.some((record) => record.url.includes('cursor=event-page-2'))).toBe(true);
  });

  it('keeps the last transcript when event polling is temporarily unavailable', async () => {
    api.events = [event(1, 'agent_message', { sessionUpdate: 'agent_message', messageId: 'm1', content: [{ type: 'text', text: 'retained output' }] }, { type: 'agent_message', id: 'm1' })];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPanel();
    expect(await screen.findByText('retained output')).toBeTruthy();

    api.eventError = true;
    await vi.advanceTimersByTimeAsync(3000);

    expect((await screen.findByRole('status', { name: /live output/i })).textContent).toMatch(/showing last observed output/i);
    expect(screen.getByText('retained output')).toBeTruthy();
  });

  it('clears transcript, requests, and drafts after access is revoked', async () => {
    api.events = [event(1, 'agent_message', { sessionUpdate: 'agent_message', messageId: 'private', content: [{ type: 'text', text: 'private transcript' }] }, { type: 'agent_message', id: 'private' })];
    api.requests = [{
      requestKey: '1:permission:7',
      kind: 'permission',
      payload: { sessionId: 's1', title: 'Private approval', options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }] },
      status: 'open',
      createdAt,
      resolvedAt: null,
    }];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel();
    const prompt = await screen.findByLabelText(/prompt/i);
    await user.type(prompt, 'private draft');
    expect(screen.getByText('private transcript')).toBeTruthy();
    expect(screen.getByText('Private approval')).toBeTruthy();

    api.denied = true;
    await vi.advanceTimersByTimeAsync(3000);

    expect(await screen.findByText('Execution access is no longer available.')).toBeTruthy();
    expect(screen.queryByText('private transcript')).toBeNull();
    expect(screen.queryByText('Private approval')).toBeNull();
    expect(screen.queryByDisplayValue('private draft')).toBeNull();
  });

  it('keeps access denial visible while the task claim list remains readable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPanel();
    await waitForClaim();

    api.privateDenied = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(await screen.findByText('Execution access is no longer available.')).toBeTruthy();

    await vi.advanceTimersByTimeAsync(6000);
    expect(screen.getByText('Execution access is no longer available.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /spec.*attempt 1/i })).toBeNull();
  });

  it('does not show the previous transcript while a new claim selection loads', async () => {
    const second = claim('claimed', { id: 42, claimType: 'build', attempt: 2, rootClaimId: 41 });
    api.claims = [second, claim()];
    api.details.set(second.id, fullClaim(second));
    const secondEvents = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.includes('/claim-executions/41/events?')) {
        return Promise.resolve(json({ data: [event(1, 'agent_message', { sessionUpdate: 'agent_message', messageId: 'claim-a', content: [{ type: 'text', text: 'Claim A transcript' }] }, { type: 'agent_message', id: 'claim-a' })], nextCursor: null }));
      }
      if (url.includes('/claim-executions/42/events?')) return secondEvents.promise;
      return fetchStub(input, init);
    }));
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByText('Claim A transcript')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /build.*attempt 2/i }));

    expect(screen.queryByText('Claim A transcript')).toBeNull();
    expect(screen.getByText('No output observed yet.')).toBeTruthy();
  });
});

describe('claim controls', () => {
  it('submits only the start contract, retains a failed draft and key, then clears an accepted replay', async () => {
    api.startResponses = [
      { status: 500, payload: { error: { code: 'internal_error', message: 'private database failure' } } },
      { status: 200, payload: { data: { claim: fullClaim(claim('pending')), created: false } } },
    ];
    const user = userEvent.setup();
    renderPanel();
    await waitForClaim();
    await user.click(screen.getByRole('button', { name: /start execution/i }));
    await user.selectOptions(screen.getByLabelText(/phase/i), 'build');
    await user.type(screen.getByLabelText(/repository/i), 'acme/fluent-flow');
    await user.type(screen.getByLabelText(/pull request/i), '127');
    await user.type(screen.getByLabelText(/branch/i), 'feature/acp');
    await user.type(screen.getByLabelText(/instructions/i), 'Continue from the approved plan.');

    for (const forbidden of ['host', 'process', 'adapter', 'profile', 'path']) {
      expect(screen.queryByLabelText(new RegExp(forbidden, 'i'))).toBeNull();
    }

    await user.click(screen.getByRole('button', { name: /^start$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not start/i);
    expect(screen.getByDisplayValue('Continue from the approved plan.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^start$/i }));

    await waitFor(() => expect(screen.queryByDisplayValue('Continue from the approved plan.')).toBeNull());
    const requests = api.records.filter((record) => record.method === 'POST' && record.url.endsWith(`/tasks/${TASK_ID}/claim-executions`));
    expect(requests).toHaveLength(2);
    expect(requests[0].headers.get('idempotency-key')).toBe('00000000-0000-4000-8000-000000000001');
    expect(requests[1].headers.get('idempotency-key')).toBe(requests[0].headers.get('idempotency-key'));
    expect(requests[0].body).toEqual({
      expectedVersion: 3,
      repo: 'acme/fluent-flow',
      claimType: 'build',
      prNumber: 127,
      branch: 'feature/acp',
      instructions: 'Continue from the approved plan.',
    });
    expect(requests[0].body).not.toEqual(expect.objectContaining({ host: expect.anything(), process: expect.anything(), adapter: expect.anything(), profile: expect.anything(), path: expect.anything() }));
  });

  it('retries a failed prompt with the same key and clears an accepted replay once', async () => {
    stubUniqueKeys();
    api.commandResponses = [
      { status: 500, payload: { error: { code: 'internal_error', message: 'private command failure' } } },
      { status: 200, payload: { data: { commandId: 91, kind: 'prompt', status: 'pending', created: false } } },
    ];
    const user = userEvent.setup();
    renderPanel();
    const prompt = await screen.findByLabelText(/prompt/i);
    await user.type(prompt, 'Continue safely');
    await user.click(screen.getByRole('button', { name: /send prompt/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/prompt could not be sent/i);
    const promptInput = prompt as HTMLTextAreaElement;
    expect(promptInput.value).toBe('Continue safely');
    await user.click(screen.getByRole('button', { name: /send prompt/i }));
    await waitFor(() => expect(promptInput.value).toBe(''));

    const requests = commandRecords('prompt');
    expect(requests).toHaveLength(2);
    expect(requests[0].body).toEqual({ kind: 'prompt', payload: { text: 'Continue safely' } });
    expect(requests[1].headers.get('idempotency-key')).toBe(requests[0].headers.get('idempotency-key'));
  });

  it('rotates the prompt key when a failed draft is edited', async () => {
    stubUniqueKeys();
    api.commandResponses = [{ status: 500, payload: { error: { code: 'internal_error', message: 'private command failure' } } }];
    const user = userEvent.setup();
    renderPanel();
    const prompt = await screen.findByLabelText(/prompt/i);
    await user.type(prompt, 'First draft');
    await user.click(screen.getByRole('button', { name: /send prompt/i }));
    await screen.findByRole('alert');

    await user.clear(prompt);
    await user.type(prompt, 'Edited draft');
    await user.click(screen.getByRole('button', { name: /send prompt/i }));

    await waitFor(() => expect(commandRecords('prompt')).toHaveLength(2));
    expect(commandRecords('prompt').map((record) => record.body)).toEqual([
      { kind: 'prompt', payload: { text: 'First draft' } },
      { kind: 'prompt', payload: { text: 'Edited draft' } },
    ]);
    expect(commandRecords('prompt')[1].headers.get('idempotency-key')).not.toBe(commandRecords('prompt')[0].headers.get('idempotency-key'));
  });

  it('rotates the prompt key after an idempotency conflict and accepts the retry', async () => {
    stubUniqueKeys();
    api.commandResponses = [
      { status: 409, payload: { error: { code: 'idempotency_conflict', message: 'private conflict detail' } } },
      { status: 202, payload: { data: { commandId: 92, kind: 'prompt', status: 'pending', created: true } } },
    ];
    const user = userEvent.setup();
    renderPanel();
    const prompt = await screen.findByLabelText(/prompt/i);
    await user.type(prompt, 'Recover this prompt');
    await user.click(screen.getByRole('button', { name: /send prompt/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be sent/i);
    await user.click(screen.getByRole('button', { name: /send prompt/i }));

    await waitFor(() => expect((prompt as HTMLTextAreaElement).value).toBe(''));
    expect(commandRecords('prompt')[1].headers.get('idempotency-key')).not.toBe(commandRecords('prompt')[0].headers.get('idempotency-key'));
  });

  it('limits prompts to 20000 characters', async () => {
    renderPanel();
    const prompt = await screen.findByLabelText(/prompt/i) as HTMLTextAreaElement;

    expect(prompt.maxLength).toBe(20000);
  });

  it('retries a failed cancellation with the same key', async () => {
    stubUniqueKeys();
    api.commandResponses = [
      { status: 500, payload: { error: { code: 'internal_error', message: 'private cancellation failure' } } },
      { status: 202, payload: { data: { commandId: 93, kind: 'cancel', status: 'pending', created: false } } },
    ];
    const user = userEvent.setup();
    renderPanel();
    await waitForClaim();
    await user.click(screen.getByRole('button', { name: /cancel execution/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/cancellation could not be sent/i);
    await user.click(screen.getByRole('button', { name: /cancel execution/i }));

    await waitFor(() => expect(commandRecords('cancel')).toHaveLength(2));
    expect(commandRecords('cancel')[1].headers.get('idempotency-key')).toBe(commandRecords('cancel')[0].headers.get('idempotency-key'));
  });

  it('clears prompt state and its key when claim selection changes', async () => {
    stubUniqueKeys();
    const second = claim('claimed', { id: 42, claimType: 'build', attempt: 2, rootClaimId: 41 });
    api.claims = [claim(), second];
    api.details.set(second.id, fullClaim(second));
    api.commandResponses = [{ status: 500, payload: { error: { code: 'internal_error', message: 'private command failure' } } }];
    const user = userEvent.setup();
    renderPanel();
    await waitForClaim(/build.*attempt 2/i);
    await user.click(await waitForClaim());
    const prompt = await screen.findByLabelText(/prompt/i);
    await user.type(prompt, 'Claim A draft');
    await user.click(screen.getByRole('button', { name: /send prompt/i }));
    await screen.findByRole('alert');
    const claimAKey = commandRecords('prompt')[0].headers.get('idempotency-key');

    await user.click(screen.getByRole('button', { name: /build.*attempt 2/i }));
    expect((screen.getByLabelText(/prompt/i) as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.type(screen.getByLabelText(/prompt/i), 'Claim B draft');
    await user.click(screen.getByRole('button', { name: /send prompt/i }));

    await waitFor(() => expect(commandRecords('prompt')).toHaveLength(2));
    expect(commandRecords('prompt')[1].body).toEqual({ kind: 'prompt', payload: { text: 'Claim B draft' } });
    expect(commandRecords('prompt')[1].headers.get('idempotency-key')).not.toBe(claimAKey);
  });

  it('clears a steering draft when steering permission is revoked', async () => {
    const user = userEvent.setup();
    const reload = vi.fn(async () => {});
    const view = render(<TaskClaimExecutionTab detail={detail} reload={reload} />);
    const prompt = await screen.findByLabelText(/prompt/i);
    await user.type(prompt, 'Do not retain this draft');

    meMock.value = { ...me, capabilities: { [PROJECT_ID]: allCapabilities.filter((capability) => capability !== 'run.steer') } };
    view.rerender(<TaskClaimExecutionTab detail={detail} reload={reload} />);
    expect(screen.queryByLabelText(/prompt/i)).toBeNull();
    meMock.value = me;
    view.rerender(<TaskClaimExecutionTab detail={detail} reload={reload} />);

    expect((await screen.findByLabelText(/prompt/i) as HTMLTextAreaElement).value).toBe('');
  });

  it.each(['pending', 'claimed'])('allows cancelling a %s claim with an empty payload', async (status) => {
    const value = claim(status);
    api.claims = [value];
    api.details.set(value.id, fullClaim(value));
    const user = userEvent.setup();
    renderPanel();
    await waitForClaim();
    await user.click(screen.getByRole('button', { name: /cancel execution/i }));

    await waitFor(() => expect(commandRecords('cancel')).toHaveLength(1));
    expect(commandRecords('cancel')[0].body).toEqual({ kind: 'cancel', payload: {} });
  });

  it.each([
    ['task', { ...detail, capabilities: allCapabilities.filter((capability) => capability !== 'run.steer') }, me],
    ['project', detail, { ...me, capabilities: { [PROJECT_ID]: allCapabilities.filter((capability) => capability !== 'run.steer') } }],
  ])('hides steering controls when the %s capability source denies them', async (_source, task, currentMe) => {
    meMock.value = currentMe;
    renderPanel(task);
    await waitForClaim();

    expect(screen.queryByLabelText(/prompt/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /send prompt/i })).toBeNull();
  });

  it('requires both task and project capabilities for start and cancel controls', async () => {
    meMock.value = { ...me, capabilities: { [PROJECT_ID]: ['task.read', 'internal.read', 'run.steer'] } };
    renderPanel({ ...detail, capabilities: ['task.read', 'internal.read', 'run.start', 'run.steer', 'run.cancel'] });
    await waitForClaim();

    expect(screen.queryByRole('button', { name: /start execution/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /cancel execution/i })).toBeNull();
  });
});

describe('permission and elicitation requests', () => {
  it('submits selected and dismissed permission answers with the opaque request key', async () => {
    api.requests = [{
      requestKey: '1:permission:request-7',
      kind: 'permission',
      payload: {
        sessionId: 'session-1',
        title: 'Allow command?',
        description: 'The agent wants to inspect status.',
        subject: { type: 'command', command: 'git status', cwd: '/workspace/repo' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      },
      status: 'open',
      createdAt,
      resolvedAt: null,
    }];
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByText('git status')).toBeTruthy();
    expect(screen.queryByText('/workspace/repo')).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Allow once' }));

    await waitFor(() => expect(commandRecords('permission')).toHaveLength(1));
    expect(commandRecords('permission')[0].body).toEqual({
      kind: 'permission',
      requestKey: '1:permission:request-7',
      payload: { answer: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
    });

    cleanup();
    api.records = [];
    api.requests[0] = { ...api.requests[0], requestKey: '2:permission:request-8' };
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /dismiss/i }));
    expect(commandRecords('permission')[0].body).toEqual({
      kind: 'permission',
      requestKey: '2:permission:request-8',
      payload: { answer: { outcome: { outcome: 'cancelled' } } },
    });
  });

  it('reuses an answer key for the same failed body and rotates it for a different answer', async () => {
    stubUniqueKeys();
    api.requests = [{
      requestKey: '1:permission:retry',
      kind: 'permission',
      payload: {
        sessionId: 'session-1',
        title: 'Choose access',
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      },
      status: 'open',
      createdAt,
      resolvedAt: null,
    }];
    api.commandResponses = [
      { status: 500, payload: { error: { code: 'internal_error', message: 'private failure' } } },
      { status: 500, payload: { error: { code: 'internal_error', message: 'private failure' } } },
    ];
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(commandRecords('permission')).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(commandRecords('permission')).toHaveLength(3));

    const records = commandRecords('permission');
    expect(records[1].headers.get('idempotency-key')).toBe(records[0].headers.get('idempotency-key'));
    expect(records[2].headers.get('idempotency-key')).not.toBe(records[1].headers.get('idempotency-key'));
  });

  it('prevents duplicate answer submissions while the first request is pending', async () => {
    api.requests = [{
      requestKey: '1:permission:pending',
      kind: 'permission',
      payload: { sessionId: 'session-1', title: 'Approve once', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
      status: 'open',
      createdAt,
      resolvedAt: null,
    }];
    const pending = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith('/commands') && (init.method ?? 'GET') === 'POST') {
        api.records.push({
          url,
          method: 'POST',
          headers: new Headers(init.headers),
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        });
        return pending.promise;
      }
      return fetchStub(input, init);
    }));
    const user = userEvent.setup();
    renderPanel();
    const allow = await screen.findByRole('button', { name: 'Allow' });
    await user.click(allow);
    await user.click(allow);

    expect(commandRecords('permission')).toHaveLength(1);
  });

  it('makes a request actionable again when the server reopens it', async () => {
    api.requests = [{
      requestKey: '1:permission:reopened',
      kind: 'permission',
      payload: { sessionId: 'session-1', title: 'Reopened approval', options: [{ optionId: 'allow', name: 'Allow again', kind: 'allow_once' }] },
      status: 'open',
      createdAt,
      resolvedAt: null,
    }];
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Allow again' }));

    expect((await screen.findByRole('button', { name: 'Allow again' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Answer sent, waiting for the agent server')).toBeNull();
  });

  it('explains that an answer failed because the claim is no longer active', async () => {
    api.requests = [{
      requestKey: '1:permission:inactive',
      kind: 'permission',
      payload: { sessionId: 'session-1', title: 'Expired approval', options: [{ optionId: 'allow', name: 'Allow expired', kind: 'allow_once' }] },
      status: 'open',
      createdAt,
      resolvedAt: null,
    }];
    api.commandResponses = [{ status: 409, payload: { error: { code: 'claim_not_active', message: 'private claim detail' } } }];
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Allow expired' }));

    expect((await screen.findByRole('alert')).textContent).toBe('This execution is no longer active.');
  });

  it('submits form elicitation content and supports decline and cancel bodies', async () => {
    api.requests = [{
      requestKey: '1:elicitation:request-8',
      kind: 'elicitation',
      payload: {
        mode: 'form',
        sessionId: 'session-1',
        message: 'Choose deployment settings',
        requestedSchema: {
          type: 'object',
          required: ['environment'],
          properties: {
            environment: { type: 'string', title: 'Environment', enum: ['staging', 'production'] },
            verbose: { type: 'boolean', title: 'Verbose' },
          },
        },
      },
      status: 'open',
      createdAt,
      resolvedAt: null,
    }];
    const user = userEvent.setup();
    renderPanel();
    await user.selectOptions(await screen.findByLabelText('Environment'), 'staging');
    await user.click(screen.getByLabelText('Verbose'));
    await user.click(screen.getByRole('button', { name: /accept response/i }));

    await waitFor(() => expect(commandRecords('elicitation')).toHaveLength(1));
    expect(commandRecords('elicitation')[0].body).toEqual({
      kind: 'elicitation',
      requestKey: '1:elicitation:request-8',
      payload: { answer: { action: 'accept', content: { environment: 'staging', verbose: true } } },
    });

    cleanup();
    api.records = [];
    api.requests[0] = { ...api.requests[0], requestKey: '2:elicitation:request-9' };
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /^decline$/i }));
    expect(commandRecords('elicitation')[0].body).toEqual({
      kind: 'elicitation',
      requestKey: '2:elicitation:request-9',
      payload: { answer: { action: 'decline' } },
    });

    cleanup();
    api.records = [];
    api.requests[0] = { ...api.requests[0], requestKey: '3:elicitation:request-10' };
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /^cancel$/i }));
    expect(commandRecords('elicitation')[0].body).toEqual({
      kind: 'elicitation',
      requestKey: '3:elicitation:request-10',
      payload: { answer: { action: 'cancel' } },
    });
  });

  it('accepts comma-separated free-text array values typed one character at a time', async () => {
    api.requests = [{
      requestKey: '1:elicitation:array',
      kind: 'elicitation',
      payload: {
        mode: 'form',
        sessionId: 'session-1',
        message: 'Choose labels',
        requestedSchema: {
          type: 'object',
          required: ['labels'],
          properties: {
            labels: { type: 'array', title: 'Labels', items: { type: 'string' } },
          },
        },
      },
      status: 'open',
      createdAt,
      resolvedAt: null,
    }];
    const user = userEvent.setup();
    renderPanel();
    await user.type(await screen.findByLabelText('Labels'), 'alpha, beta');
    await user.click(screen.getByRole('button', { name: /accept response/i }));

    await waitFor(() => expect(commandRecords('elicitation')).toHaveLength(1));
    expect(commandRecords('elicitation')[0].body).toEqual({
      kind: 'elicitation',
      requestKey: '1:elicitation:array',
      payload: { answer: { action: 'accept', content: { labels: ['alpha', 'beta'] } } },
    });
  });

  it('initializes and submits a required boolean as false', async () => {
    api.requests = [{
      requestKey: '1:elicitation:boolean',
      kind: 'elicitation',
      payload: {
        mode: 'form',
        sessionId: 'session-1',
        message: 'Confirm rollout',
        requestedSchema: {
          type: 'object',
          required: ['confirmed'],
          properties: { confirmed: { type: 'boolean', title: 'Confirmed' } },
        },
      },
      status: 'open',
      createdAt,
      resolvedAt: null,
    }];
    const user = userEvent.setup();
    renderPanel();
    expect((await screen.findByLabelText('Confirmed') as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByRole('button', { name: /accept response/i }));

    await waitFor(() => expect(commandRecords('elicitation')).toHaveLength(1));
    expect(commandRecords('elicitation')[0].body).toEqual({
      kind: 'elicitation',
      requestKey: '1:elicitation:boolean',
      payload: { answer: { action: 'accept', content: { confirmed: false } } },
    });
  });

  it('omits optional number, string, enum, and date fields after they are cleared', async () => {
    api.requests = [{
      requestKey: '1:elicitation:cleared',
      kind: 'elicitation',
      payload: {
        mode: 'form',
        sessionId: 'session-1',
        message: 'Optional settings',
        requestedSchema: {
          type: 'object',
          properties: {
            replicas: { type: 'number', title: 'Replicas' },
            note: { type: 'string', title: 'Note' },
            environment: { type: 'string', title: 'Environment', enum: ['staging', 'production'] },
            deployOn: { type: 'string', format: 'date', title: 'Deploy on' },
          },
        },
      },
      status: 'open',
      createdAt,
      resolvedAt: null,
    }];
    const user = userEvent.setup();
    renderPanel();
    const replicas = await screen.findByLabelText('Replicas');
    const note = screen.getByLabelText('Note');
    const environment = screen.getByLabelText('Environment');
    const deployOn = screen.getByLabelText('Deploy on');
    await user.type(replicas, '3');
    await user.type(note, 'temporary');
    await user.selectOptions(environment, 'staging');
    await user.type(deployOn, '2026-11-06');
    await user.clear(replicas);
    await user.clear(note);
    await user.selectOptions(environment, '');
    await user.clear(deployOn);
    await user.click(screen.getByRole('button', { name: /accept response/i }));

    await waitFor(() => expect(commandRecords('elicitation')).toHaveLength(1));
    expect(commandRecords('elicitation')[0].body).toEqual({
      kind: 'elicitation',
      requestKey: '1:elicitation:cleared',
      payload: { answer: { action: 'accept', content: {} } },
    });
  });

  it('marks queued and stale answers as non-actionable', async () => {
    api.requests = [{
      requestKey: '1:permission:stale',
      kind: 'permission',
      payload: { sessionId: 'session-1', title: 'Stale approval', options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] },
      status: 'open',
      createdAt,
      resolvedAt: null,
    }];
    api.commandResponses = [{ status: 409, payload: { error: { code: 'request_conflict', message: 'private stale detail' } } }];
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    expect((await screen.findByRole('alert')).textContent).toContain('This request is no longer available.');

    cleanup();
    api.requests = [{ ...api.requests[0], status: 'answer_queued' }];
    renderPanel();
    expect(await screen.findByText('Answer sent, waiting for the agent server')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  });
});

describe('safe and accessible rendering', () => {
  it('renders untrusted text literally without links, media, frames, or remote requests', async () => {
    api.events = [event(1, 'agent_message', {
      sessionUpdate: 'agent_message',
      messageId: 'unsafe',
      content: [
        { type: 'text', text: '<img src="https://attacker.test/pixel"><script>alert(1)</script>' },
        { type: 'image', mimeType: 'image/png', data: 'https://attacker.test/image.png' },
        { type: 'resource_link', uri: 'https://attacker.test/resource' },
      ],
    }, { type: 'agent_message', id: 'unsafe' })];
    renderPanel();

    expect(await screen.findByText(/<img src=.*<script>alert\(1\)<\/script>/)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.querySelector('a[href^="http"]')).toBeNull();
    expect(api.records.some((record) => record.url.includes('attacker.test'))).toBe(false);
  });

  it('ignores malformed raw key and type fields without corrupting React identity', async () => {
    api.events = [
      event(1, 'vendor_update', { sessionUpdate: 'vendor_update', key: { poisoned: true }, type: null, value: 'first' }, { type: 'vendor', id: 'one' }),
      event(2, 'vendor_update', { sessionUpdate: 'vendor_update', key: 'duplicate', type: 7, value: 'second' }, { type: 'vendor', id: 'two' }),
    ];
    renderPanel();

    const log = await screen.findByRole('log');
    expect(await within(log).findAllByText('vendor')).toHaveLength(2);
  });

  it('ignores a null schema property without crashing the request panel', async () => {
    api.requests = [{
      requestKey: '1:elicitation:null-property',
      kind: 'elicitation',
      payload: {
        mode: 'form',
        sessionId: 'session-1',
        message: 'Mixed schema',
        requestedSchema: {
          type: 'object',
          properties: {
            broken: null,
            safe: { type: 'string', title: 'Safe value' },
          },
        },
      },
      status: 'open',
      createdAt,
      resolvedAt: null,
    }];
    renderPanel();

    expect(await screen.findByText('Mixed schema')).toBeTruthy();
    expect(screen.getByLabelText('Safe value')).toBeTruthy();
    expect(screen.getByRole('button', { name: /accept response/i })).toBeTruthy();
  });

  it('uses native keyboard controls, exposes selection, and makes the transcript keyboard-scrollable', async () => {
    api.events = [event(1, 'agent_message', { sessionUpdate: 'agent_message', messageId: 'm1', content: [{ type: 'text', text: 'keyboard output' }] }, { type: 'agent_message', id: 'm1' })];
    const user = userEvent.setup();
    renderPanel();
    const row = await waitForClaim();
    expect(row.getAttribute('aria-pressed')).toBe('true');
    row.focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(row);

    const log = await screen.findByRole('log');
    expect(log.getAttribute('tabindex')).toBe('0');
    expect(within(log).getByText('keyboard output')).toBeTruthy();
    log.focus();
    expect(document.activeElement).toBe(log);
  });
});
