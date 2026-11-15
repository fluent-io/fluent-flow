import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentDetail } from '@fluent-flow/db';
import { AgentDetailHeader } from '@/components/agents/agent-detail-header';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

const FORBIDDEN_STRINGS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_AUTH_JSON',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'agent_type',
  'opencode',
];

function agent(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: 'laptop-1',
    org_id: 'org-a',
    agent_type: 'codex',
    transport: 'long_poll',
    transport_meta: {},
    repos: ['fluent-io/fluent-flow'],
    created_at: new Date('2026-11-01T10:00:00Z'),
    updated_at: new Date('2026-11-01T10:00:00Z'),
    status: 'online',
    last_seen_at: new Date('2026-11-02T10:00:00Z'),
    deployment: 'self_hosted',
    capacity: 4,
    active_slots: 2,
    busy_chat: 0,
    busy_work: 0,
    max_chat_slots: null,
    ...overrides,
  };
}

function renderHeader(overrides: Partial<AgentDetail> = {}, status: string | null = 'online') {
  return render(
    <AgentDetailHeader
      agent={agent(overrides)}
      keyInfo={{ id: 1, created_at: '2026-11-02T10:00:00Z' }}
      status={status}
      isAdmin
    />,
  );
}

function field(label: string, value: string) {
  const pattern = new RegExp(`^\\s*${label}\\s*:?\\s*${value}\\s*$`);
  return screen.getByText((_, element) => {
    if (!element || !pattern.test(element.textContent ?? '')) return false;
    return !Array.from(element.children).some((child) => pattern.test(child.textContent ?? ''));
  });
}

beforeEach(() => {
  router.push.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('AgentDetailHeader slots and deployment', () => {
  it('shows active slots against capacity', () => {
    renderHeader({ active_slots: 2, capacity: 4 });
    expect(field('Slots', '2\\s*\\/\\s*4')).toBeTruthy();
  });

  it('falls back to an em dash when capacity is null', () => {
    renderHeader({ active_slots: 1, capacity: null });
    expect(field('Slots', '1\\s*\\/\\s*\\u2014')).toBeTruthy();
  });

  it('shows zero active slots for an offline server', () => {
    renderHeader({ active_slots: 0, capacity: 2 }, 'offline');
    expect(field('Slots', '0\\s*\\/\\s*2')).toBeTruthy();
  });

  it.each([
    ['local', 'Local'],
    ['self_hosted', 'Self-hosted'],
    ['hosted', 'Hosted'],
    [null, '\\u2014'],
  ] as const)('shows deployment %j as %j', (deployment, label) => {
    renderHeader({ deployment });
    expect(field('Deployment', label)).toBeTruthy();
  });
});

describe('AgentDetailHeader chat capacity', () => {
  it('reports the effective chat limit conservatively from advertised capacity', () => {
    renderHeader({ capacity: 4, max_chat_slots: null });
    expect(field('Chat slots', '3 effective of 4 · configured default')).toBeTruthy();
  });

  it('caps the configured value at capacity minus one', () => {
    renderHeader({ capacity: 4, max_chat_slots: 15 });
    expect(field('Chat slots', '3 effective of 4 · configured 15')).toBeTruthy();
  });

  it('reports chats disabled for capacity 1 even when configured higher', () => {
    renderHeader({ capacity: 1, max_chat_slots: 5 });
    expect(field('Chat slots', 'chats disabled · configured 5')).toBeTruthy();
  });

  it('reports configured zero as disabled', () => {
    renderHeader({ capacity: 8, max_chat_slots: 0 });
    expect(field('Chat slots', 'chats disabled · configured 0')).toBeTruthy();
  });

  it('reports honestly when the agent never advertised a capacity', () => {
    renderHeader({ capacity: null, max_chat_slots: 4 });
    expect(field('Chat slots', 'unknown \\(agent capacity not advertised\\) · configured 4')).toBeTruthy();
  });

  it('reports the busy chat and work split', () => {
    renderHeader({ busy_chat: 2, busy_work: 1 });
    expect(field('Busy', '3 \\(chat 2 \\/ work 1\\)')).toBeTruthy();
  });

  it('shows the admin editor only for admins', () => {
    render(
      <AgentDetailHeader agent={agent()} keyInfo={{ id: 1, created_at: '2026-11-02T10:00:00Z' }} status="online" isAdmin={false} />,
    );
    expect(screen.queryByLabelText('Max chat slots')).toBeNull();
    renderHeader();
    expect(screen.getByLabelText('Max chat slots')).toBeTruthy();
  });

  it('saves a configured chat slot value through the org-scoped API', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => new Response(
      JSON.stringify({ agent: { ...agent(), max_chat_slots: 6 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    renderHeader();
    await user.type(screen.getByLabelText('Max chat slots'), '6');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agents/laptop-1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ maxChatSlots: 6 }) }),
    );
    expect(field('Chat slots', '3 effective of 4 · configured 6')).toBeTruthy();
  });

  it('rejects out-of-range values without calling the API', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHeader();
    await user.type(screen.getByLabelText('Max chat slots'), '16');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toMatch(/0 to 15/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a permission error without internals when the save is denied', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Forbidden' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )));
    renderHeader();
    await user.type(screen.getByLabelText('Max chat slots'), '2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toMatch(/permission/i);
    expect(screen.getByRole('alert').textContent).not.toMatch(/org|agent_id|max_chat_slots/);
  });
});

describe('AgentDetailHeader identity', () => {
  it('shows the server name, status and provider', () => {
    renderHeader({ id: 'build-box', agent_type: 'codex' }, 'busy');
    expect(screen.getByRole('heading', { name: 'build-box' })).toBeTruthy();
    expect(screen.getByText(/busy/)).toBeTruthy();
    expect(field('Provider', 'codex')).toBeTruthy();
  });

  it('does not label the provider as a type', () => {
    renderHeader();
    expect(screen.queryByText(/^\s*Type\s*:/)).toBeNull();
  });

  it('mentions no provider secret names or removed type names', () => {
    renderHeader();
    const html = document.body.innerHTML.toLowerCase();
    for (const forbidden of FORBIDDEN_STRINGS) {
      expect(html, `UI must not mention ${forbidden}`).not.toContain(forbidden.toLowerCase());
    }
  });
});
