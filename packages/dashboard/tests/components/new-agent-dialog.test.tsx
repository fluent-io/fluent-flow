import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';

const sessionState = vi.hoisted(() => ({ value: null as unknown }));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: sessionState.value, status: 'authenticated' }),
}));

const LOCAL_COMMAND =
  'npx @fluent-flow/agent-server@latest \\\n  --server https://flow.example.com \\\n  --provider codex \\\n  --capacity 4 \\\n  --enrollment-token enr_local_secret';
const DOCKER_COMMAND =
  'docker run -d --name fluent-flow-agent-server --restart unless-stopped --init \\\n  ghcr.io/fluent-io/fluent-flow-agent-server:latest \\\n  --server https://flow.example.com \\\n  --provider claude-code \\\n  --capacity 2 \\\n  --deployment self_hosted \\\n  --enrollment-token enr_docker_secret \\\n  --provider-secret-file /run/secrets/provider-auth';

const FORBIDDEN_STRINGS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_AUTH_JSON',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'agent_type',
  'opencode',
];

interface PostRecord {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function reply(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function replyWithoutJson(status: number): FakeResponse {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  };
}

let posts: PostRecord[];
let gets: string[];
let createResponse: () => Promise<FakeResponse> | FakeResponse;
let detailResponse: () => Promise<FakeResponse> | FakeResponse;
let commandForCreate: () => string;
let expiresInMinutes: number;

function offlineDetail(): FakeResponse {
  return reply({ status: 'offline', active_slots: 0, sessions: [] });
}

function onlineDetail(): FakeResponse {
  return reply({
    status: 'online',
    active_slots: 1,
    sessions: [{ id: 1, status: 'online' }],
  });
}

function setSession(orgIds: string[], isSuperadmin = false, role = 'admin') {
  sessionState.value = {
    user: { isSuperadmin, orgs: orgIds.map((org_id) => ({ org_id, role })) },
  };
}

beforeEach(() => {
  posts = [];
  gets = [];
  expiresInMinutes = 15;
  commandForCreate = () => LOCAL_COMMAND;
  createResponse = () =>
    reply(
      {
        agent: { id: 'laptop-1', org_id: 'org-a' },
        command: commandForCreate(),
        enrollment_expires_at: new Date(Date.now() + expiresInMinutes * 60_000).toISOString(),
      },
      201,
    );
  detailResponse = offlineDetail;
  setSession(['org-a']);
  router.push.mockReset();
  router.refresh.mockReset();
  router.replace.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      if (method === 'POST' && url === '/api/agents') {
        posts.push({ url, init, body: JSON.parse(String(init.body)) });
        return createResponse();
      }
      if (method === 'GET' && url.startsWith('/api/agents/')) {
        gets.push(url);
        return detailResponse();
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function makeUser() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

type User = UserEvent;

async function openDialog(user: User) {
  render(<NewAgentDialog />);
  await user.click(screen.getByRole('button', { name: /new agent server/i }));
  return screen.findByRole('dialog');
}

interface FormValues {
  name?: string;
  provider?: string;
  capacity?: string;
  deployment?: 'Local (npm)' | 'Self-hosted (Docker)';
  org?: string;
}

async function fillForm(user: User, values: FormValues) {
  if (values.org) {
    await user.selectOptions(screen.getByLabelText(/^organization/i), values.org);
  }
  if (values.name !== undefined) {
    await user.type(screen.getByLabelText(/^server name/i), values.name);
  }
  if (values.provider) {
    await user.selectOptions(screen.getByLabelText(/^provider/i), values.provider);
  }
  if (values.capacity !== undefined) {
    const capacity = screen.getByLabelText(/^capacity/i);
    await user.clear(capacity);
    if (values.capacity !== '') await user.type(capacity, values.capacity);
  }
  if (values.deployment) {
    await user.selectOptions(screen.getByLabelText(/^deployment/i), values.deployment);
  }
}

function nextButton() {
  return screen.getByRole('button', { name: /next/i });
}

async function submit(user: User, values: FormValues = { name: 'laptop-1' }) {
  await fillForm(user, values);
  await user.click(nextButton());
}

async function reachStep2(user: User, values: FormValues = { name: 'laptop-1' }) {
  await openDialog(user);
  await submit(user, values);
  await screen.findByRole('button', { name: /copy command/i });
}

async function expandSetupInstructions(user: User) {
  const toggle = screen.queryByRole('button', { name: /setup instructions/i });
  if (toggle && toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);
}

function textExcludingCommand(): string {
  const clone = document.body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('pre').forEach((node) => node.remove());
  return clone.textContent ?? '';
}

function expectNoForbiddenStrings() {
  const html = document.body.innerHTML.toLowerCase();
  for (const forbidden of FORBIDDEN_STRINGS) {
    expect(html, `UI must not mention ${forbidden}`).not.toContain(forbidden.toLowerCase());
  }
}

function useFakePollTimers() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
}

async function macrotask() {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  await promise;
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    await macrotask();
  });
}

async function advancePoll(ms = 2000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await macrotask();
  });
}

describe('New agent server dialog: trigger and form', () => {
  it('opens a dialog titled "New agent server" from a "New agent server" trigger', async () => {
    const user = makeUser();
    const dialog = await openDialog(user);
    expect(within(dialog).getByRole('heading', { name: /^new agent server$/i })).toBeTruthy();
  });

  it('is not offered to users who administer no organization', () => {
    setSession(['org-a'], false, 'member');
    render(<NewAgentDialog />);
    expect(screen.queryByRole('button', { name: /new agent server/i })).toBeNull();
  });

  it('exposes labelled controls with the contract defaults', async () => {
    const user = makeUser();
    await openDialog(user);

    const name = screen.getByLabelText(/^server name/i) as HTMLInputElement;
    expect(name.value).toBe('');

    const provider = screen.getByLabelText(/^provider/i) as HTMLSelectElement;
    expect(provider.value).toBe('claude-code');

    const capacity = screen.getByLabelText(/^capacity/i) as HTMLInputElement;
    expect(capacity.type).toBe('number');
    expect(capacity.min).toBe('1');
    expect(capacity.max).toBe('16');
    expect(capacity.value).toBe('2');

    const deployment = screen.getByLabelText(/^deployment/i) as HTMLSelectElement;
    expect(deployment.selectedOptions[0]?.textContent).toBe('Local (npm)');
  });

  it('offers exactly the claude-code and codex providers', async () => {
    const user = makeUser();
    await openDialog(user);
    const provider = screen.getByLabelText(/^provider/i) as HTMLSelectElement;
    expect(Array.from(provider.options).map((option) => option.value)).toEqual(['claude-code', 'codex']);
  });

  it('offers exactly the Local (npm) and Self-hosted (Docker) deployments', async () => {
    const user = makeUser();
    await openDialog(user);
    const deployment = screen.getByLabelText(/^deployment/i) as HTMLSelectElement;
    expect(Array.from(deployment.options).map((option) => option.textContent)).toEqual([
      'Local (npm)',
      'Self-hosted (Docker)',
    ]);
  });

  it('hides the organization control when only one organization is eligible', async () => {
    const user = makeUser();
    await openDialog(user);
    expect(screen.queryByLabelText(/^organization/i)).toBeNull();
  });

  it('shows a labelled organization control listing every eligible organization', async () => {
    setSession(['org-a', 'org-b', 'org-c']);
    const user = makeUser();
    await openDialog(user);
    const org = screen.getByLabelText(/^organization/i) as HTMLSelectElement;
    expect(Array.from(org.options).map((option) => option.value)).toEqual(['org-a', 'org-b', 'org-c']);
    expect(org.value).toBe('org-a');
  });

  it('lets superadmins pick any organization they can see', async () => {
    setSession(['org-a', 'org-z'], true, 'member');
    const user = makeUser();
    await openDialog(user);
    const org = screen.getByLabelText(/^organization/i) as HTMLSelectElement;
    expect(Array.from(org.options).map((option) => option.value)).toEqual(['org-a', 'org-z']);
  });

  it('disables Next until a server name is entered', async () => {
    const user = makeUser();
    await openDialog(user);
    expect((nextButton() as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText(/^server name/i), 'laptop-1');
    expect((nextButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('New agent server dialog: capacity bounds', () => {
  it('shows no capacity feedback for the default value', async () => {
    const user = makeUser();
    await openDialog(user);
    await user.type(screen.getByLabelText(/^server name/i), 'laptop-1');
    expect(screen.queryByText(/between 1 and 16/i)).toBeNull();
    expect(screen.getByLabelText(/^capacity/i).getAttribute('aria-invalid')).not.toBe('true');
  });

  it.each(['0', '17', '100', '-1', '1.5', ''])(
    'disables Next, flags the field and explains the 1 to 16 range for capacity %j',
    async (value) => {
      const user = makeUser();
      await openDialog(user);
      await fillForm(user, { name: 'laptop-1', capacity: value });
      expect((nextButton() as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByLabelText(/^capacity/i).getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByText(/between 1 and 16/i)).toBeTruthy();
      await user.click(nextButton());
      expect(posts).toHaveLength(0);
    },
  );

  it.each(['1', '16'])('accepts the boundary capacity %s', async (value) => {
    const user = makeUser();
    await openDialog(user);
    await fillForm(user, { name: 'laptop-1', capacity: value });
    expect((nextButton() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/between 1 and 16/i)).toBeNull();
  });
});

describe('New agent server dialog: creating a server', () => {
  it('posts the default provider, capacity and local deployment with the contract body shape', async () => {
    const user = makeUser();
    await openDialog(user);
    await submit(user, { name: 'laptop-1' });
    await screen.findByRole('button', { name: /copy command/i });

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/api/agents');
    expect(posts[0].init.method).toBe('POST');
    expect(new Headers(posts[0].init.headers).get('content-type')).toBe('application/json');
    expect(posts[0].body).toEqual({
      org_id: 'org-a',
      agent_id: 'laptop-1',
      provider: 'claude-code',
      capacity: 2,
      deployment: 'local',
    });
    expect(typeof posts[0].body.capacity).toBe('number');
  });

  it('posts the chosen organization, codex provider, numeric capacity and self_hosted deployment', async () => {
    setSession(['org-a', 'org-b']);
    commandForCreate = () => DOCKER_COMMAND;
    const user = makeUser();
    await openDialog(user);
    await submit(user, {
      org: 'org-b',
      name: 'build-box',
      provider: 'codex',
      capacity: '8',
      deployment: 'Self-hosted (Docker)',
    });
    await screen.findByRole('button', { name: /copy command/i });

    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      org_id: 'org-b',
      agent_id: 'build-box',
      provider: 'codex',
      capacity: 8,
      deployment: 'self_hosted',
    });
  });

  it('never sends agent_type or an opencode provider', async () => {
    const user = makeUser();
    await openDialog(user);
    await submit(user, { name: 'laptop-1', provider: 'codex' });
    await screen.findByRole('button', { name: /copy command/i });
    expect(Object.keys(posts[0].body).sort()).toEqual(['agent_id', 'capacity', 'deployment', 'org_id', 'provider']);
  });

  it('disables Next with a busy label while creating and posts only once', async () => {
    const pending = Promise.withResolvers<FakeResponse>();
    const release = pending.resolve;
    createResponse = () => pending.promise;
    const user = makeUser();
    await openDialog(user);
    await submit(user, { name: 'laptop-1' });

    const busy = screen.getByRole('button', { name: /creating/i }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await user.click(busy);
    expect(posts).toHaveLength(1);

    await act(async () => {
      release(reply({ agent: { id: 'laptop-1' }, command: LOCAL_COMMAND, enrollment_expires_at: new Date(Date.now() + 900_000).toISOString() }, 201));
    });
    await screen.findByRole('button', { name: /copy command/i });
  });

  it('shows the API error string in an alert and stays on the form', async () => {
    createResponse = () => reply({ error: "A server named 'laptop-1' already exists" }, 409);
    const user = makeUser();
    await openDialog(user);
    await submit(user, { name: 'laptop-1' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("A server named 'laptop-1' already exists");
    expect(screen.getByLabelText(/^server name/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /copy command/i })).toBeNull();
    expect((nextButton() as HTMLButtonElement).disabled).toBe(false);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the error response has no JSON body', async () => {
    createResponse = () => replyWithoutJson(500);
    const user = makeUser();
    await openDialog(user);
    await submit(user, { name: 'laptop-1' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/request failed with 500/i);
  });

  it('clears a previous error when the next attempt succeeds', async () => {
    createResponse = () => reply({ error: "A server named 'laptop-1' already exists" }, 409);
    const user = makeUser();
    await openDialog(user);
    await submit(user, { name: 'laptop-1' });
    await screen.findByRole('alert');

    createResponse = () =>
      reply({ agent: { id: 'laptop-1' }, command: LOCAL_COMMAND, enrollment_expires_at: new Date(Date.now() + 900_000).toISOString() }, 201);
    await user.click(nextButton());
    await screen.findByRole('button', { name: /copy command/i });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('New agent server dialog: enrollment step', () => {
  it('renders the returned command verbatim and refreshes the router once', async () => {
    const user = makeUser();
    await reachStep2(user);
    const rendered = screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === LOCAL_COMMAND);
    expect(rendered).toBeTruthy();
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('copies the exact command and announces the copied state in a status region', async () => {
    const user = makeUser();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    await reachStep2(user);

    const statusText = () => screen.getAllByRole('status').map((node) => node.textContent).join(' ');
    expect(statusText()).not.toMatch(/copied/i);

    await user.click(screen.getByRole('button', { name: /copy command/i }));

    expect(writeText).toHaveBeenCalledWith(LOCAL_COMMAND);
    expect(statusText()).toMatch(/copied/i);
  });

  it('states that the enrollment is valid for 15 minutes and single use', async () => {
    const user = makeUser();
    await reachStep2(user);
    expect(screen.getByText(/valid for 15 minutes/i)).toBeTruthy();
    expect(screen.getByText(/single[- ]use/i)).toBeTruthy();
  });

  it('derives the validity window from enrollment_expires_at', async () => {
    expiresInMinutes = 30;
    const user = makeUser();
    await reachStep2(user);
    expect(screen.getByText(/valid for 30 minutes/i)).toBeTruthy();
    expect(screen.queryByText(/valid for 15 minutes/i)).toBeNull();
  });

  it('shows a waiting state in a status region', async () => {
    const user = makeUser();
    await reachStep2(user);
    const waiting = screen.getAllByRole('status').find((node) => /waiting/i.test(node.textContent ?? ''));
    expect(waiting).toBeTruthy();
  });

  it('tells local users the provider CLI login is reused', async () => {
    const user = makeUser();
    await reachStep2(user);
    await expandSetupInstructions(user);
    const text = textExcludingCommand();
    expect(text).toMatch(/provider cli/i);
    expect(text).toMatch(/login/i);
    expect(text).not.toMatch(/credential file/i);
  });

  it.each([
    ['claude-code', '@agentclientprotocol/claude-agent-acp', '@agentclientprotocol/codex-acp'],
    ['codex', '@agentclientprotocol/codex-acp', '@agentclientprotocol/claude-agent-acp'],
  ])('tells local %s users to install only that provider ACP adapter next to Node 20+, git and gh', async (provider, adapter, otherAdapter) => {
    const user = makeUser();
    await reachStep2(user, { name: 'laptop-1', provider });
    await expandSetupInstructions(user);
    const text = textExcludingCommand();

    expect(text).toContain(adapter);
    expect(text).not.toContain(otherAdapter);
    expect(text).toMatch(/install/i);
    expect(text).toMatch(/Node 20\+/);
    expect(text).toMatch(/\bgit\b/);
    expect(text).toMatch(/\bgh\b/);
  });

  it('tells self-hosted users to place the provider credential file at the mounted secret path', async () => {
    commandForCreate = () => DOCKER_COMMAND;
    const user = makeUser();
    await reachStep2(user, { name: 'laptop-1', deployment: 'Self-hosted (Docker)' });
    await expandSetupInstructions(user);
    const text = textExcludingCommand();
    expect(text).toMatch(/credential file/i);
    expect(text).toMatch(/secret path|\/run\/secrets\//i);
  });
});

describe('New agent server dialog: connection polling', () => {
  it('polls the org-scoped agent detail endpoint and stays on step 2 while no slot is online', async () => {
    useFakePollTimers();
    setSession(['org-a', 'org-b']);
    const user = makeUser();
    await reachStep2(user, { org: 'org-b', name: 'laptop-1' });
    await settle();

    expect(gets.length).toBeGreaterThanOrEqual(1);
    expect(new Set(gets)).toEqual(new Set(['/api/agents/laptop-1?org=org-b']));

    const before = gets.length;
    await advancePoll(2000);
    expect(gets.length).toBeGreaterThan(before);
    expect(screen.getByRole('button', { name: /copy command/i })).toBeTruthy();
    expect(screen.queryByText(/^connected$/i)).toBeNull();
  });

  it('keeps waiting when the detail request fails', async () => {
    useFakePollTimers();
    detailResponse = () => reply({ error: 'Unavailable' }, 503);
    const user = makeUser();
    await reachStep2(user);
    await advancePoll(4000);
    expect(screen.getByRole('button', { name: /copy command/i })).toBeTruthy();
    expect(screen.queryByText(/^connected$/i)).toBeNull();
  });

  it('moves to the connected step once a slot reports online and then stops polling', async () => {
    useFakePollTimers();
    const user = makeUser();
    await reachStep2(user);
    await advancePoll(2000);
    expect(screen.queryByText(/^connected$/i)).toBeNull();

    detailResponse = onlineDetail;
    await advancePoll(2000);

    expect(await screen.findByText(/^connected$/i)).toBeTruthy();
    expect(screen.getByText(/laptop-1 is online/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /copy command/i })).toBeNull();

    const settled = gets.length;
    await advancePoll(6000);
    expect(gets.length).toBe(settled);
  });

  it('closes from the connected step with Done', async () => {
    useFakePollTimers();
    detailResponse = onlineDetail;
    const user = makeUser();
    await reachStep2(user);
    await advancePoll(2000);
    await screen.findByText(/^connected$/i);

    await user.click(screen.getByRole('button', { name: /^done$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('New agent server dialog: reset on close', () => {
  it('discards the command and restores every default after closing from the enrollment step', async () => {
    commandForCreate = () => DOCKER_COMMAND;
    setSession(['org-a', 'org-b']);
    const user = makeUser();
    await reachStep2(user, {
      org: 'org-b',
      name: 'build-box',
      provider: 'codex',
      capacity: '8',
      deployment: 'Self-hosted (Docker)',
    });

    await user.click(screen.getByRole('button', { name: /^close$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: /new agent server/i }));
    await screen.findByRole('dialog');

    expect(screen.queryByRole('button', { name: /copy command/i })).toBeNull();
    expect((screen.getByLabelText(/^server name/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/^provider/i) as HTMLSelectElement).value).toBe('claude-code');
    expect((screen.getByLabelText(/^capacity/i) as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText(/^deployment/i) as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('Local (npm)');
  });

  it('clears a displayed error when the dialog is closed and reopened', async () => {
    createResponse = () => reply({ error: "A server named 'laptop-1' already exists" }, 409);
    const user = makeUser();
    await openDialog(user);
    await submit(user, { name: 'laptop-1' });
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: /^close$/i }));
    await user.click(screen.getByRole('button', { name: /new agent server/i }));
    await screen.findByRole('dialog');

    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText(/^server name/i) as HTMLInputElement).value).toBe('');
  });

  it('stops polling once the dialog is closed', async () => {
    useFakePollTimers();
    const user = makeUser();
    await reachStep2(user);
    await advancePoll(2000);

    await user.click(screen.getByRole('button', { name: /^close$/i }));
    await settle();
    const settled = gets.length;
    await advancePoll(8000);
    expect(gets.length).toBe(settled);
  });
});

describe('New agent server dialog: no internal leakage', () => {
  it('mentions no provider secret names or removed provider/type names on the form', async () => {
    setSession(['org-a', 'org-b']);
    const user = makeUser();
    await openDialog(user);
    expectNoForbiddenStrings();
  });

  it('mentions none of them after a failed create', async () => {
    createResponse = () => reply({ error: 'Something went wrong' }, 500);
    const user = makeUser();
    await openDialog(user);
    await submit(user, { name: 'laptop-1' });
    await screen.findByRole('alert');
    expectNoForbiddenStrings();
  });

  it.each([
    ['local', 'Local (npm)' as const, LOCAL_COMMAND],
    ['self-hosted', 'Self-hosted (Docker)' as const, DOCKER_COMMAND],
  ])('mentions none of them on the %s enrollment step with instructions expanded', async (_name, deployment, command) => {
    commandForCreate = () => command;
    const user = makeUser();
    await reachStep2(user, { name: 'laptop-1', deployment });
    await expandSetupInstructions(user);
    expectNoForbiddenStrings();
  });

  it('mentions none of them on the connected step', async () => {
    useFakePollTimers();
    detailResponse = onlineDetail;
    const user = makeUser();
    await reachStep2(user);
    await advancePoll(2000);
    await screen.findByText(/^connected$/i);
    expectNoForbiddenStrings();
  });

  it.each([
    ['local', 'Local (npm)' as const, LOCAL_COMMAND],
    ['self-hosted', 'Self-hosted (Docker)' as const, DOCKER_COMMAND],
  ])('names no environment variable outside the command on the %s enrollment step', async (_name, deployment, command) => {
    commandForCreate = () => command;
    const user = makeUser();
    await reachStep2(user, { name: 'laptop-1', deployment });
    await expandSetupInstructions(user);
    expect(textExcludingCommand()).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
  });
});
