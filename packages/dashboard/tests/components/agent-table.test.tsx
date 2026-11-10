import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentListItem } from '@fluent-flow/db';
import { AgentTable } from '@/components/agents/agent-table';

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

function agent(overrides: Partial<AgentListItem> = {}): AgentListItem {
  return {
    id: 'laptop-1',
    org_id: 'org-a',
    agent_type: 'claude-code',
    transport: 'long_poll',
    transport_meta: {},
    repos: [],
    created_at: new Date('2026-11-01T10:00:00Z'),
    updated_at: new Date('2026-11-01T10:00:00Z'),
    deployment: 'local',
    capacity: 4,
    active_slots: 1,
    status: 'online',
    last_seen_at: new Date(Date.now() - 5 * 60_000),
    ...overrides,
  };
}

function rowFor(id: string) {
  return screen.getByRole('row', { name: new RegExp(`^\\s*${id}\\b`) });
}

function cellTexts(id: string) {
  return within(rowFor(id))
    .getAllByRole('cell')
    .map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim());
}

beforeEach(() => {
  router.push.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('AgentTable columns', () => {
  it('renders the Agent Server, Provider, Slots, Status, Deployment and Last Seen columns in order', () => {
    render(<AgentTable agents={[agent()]} />);
    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent?.trim());
    expect(headers).toEqual(['Agent Server', 'Provider', 'Slots', 'Status', 'Deployment', 'Last Seen']);
  });

  it('shows the server name, provider badge, slots, status, deployment and last seen for a local server', () => {
    render(<AgentTable agents={[agent({ agent_type: 'codex', active_slots: 2, capacity: 8, status: 'busy' })]} />);
    const cells = cellTexts('laptop-1');
    expect(cells).toHaveLength(6);
    expect(cells[0]).toBe('laptop-1');
    expect(cells[1]).toBe('codex');
    expect(cells[2]).toBe('2 / 8');
    expect(cells[3]).toMatch(/busy/);
    expect(cells[4]).toBe('Local');
    expect(cells[5]).toBe('5m ago');
  });
});

describe('AgentTable slots', () => {
  it('shows active_slots / capacity', () => {
    render(<AgentTable agents={[agent({ active_slots: 3, capacity: 16 })]} />);
    expect(cellTexts('laptop-1')[2]).toBe('3 / 16');
  });

  it('shows zero active slots against a configured capacity', () => {
    render(<AgentTable agents={[agent({ active_slots: 0, capacity: 2, status: 'offline' })]} />);
    expect(cellTexts('laptop-1')[2]).toBe('0 / 2');
  });

  it('falls back to an em dash when capacity is null', () => {
    render(<AgentTable agents={[agent({ active_slots: 1, capacity: null })]} />);
    expect(cellTexts('laptop-1')[2]).toBe('1 / \u2014');
  });

  it('shows 0 / em dash for an agent that never connected and has no configured capacity', () => {
    render(<AgentTable agents={[agent({ active_slots: 0, capacity: null, status: 'offline', last_seen_at: null })]} />);
    expect(cellTexts('laptop-1')[2]).toBe('0 / \u2014');
  });
});

describe('AgentTable deployment', () => {
  it.each([
    ['local', 'Local'],
    ['self_hosted', 'Self-hosted'],
    ['hosted', 'Hosted'],
    [null, '\u2014'],
  ] as const)('renders deployment %j as %j', (deployment, label) => {
    render(<AgentTable agents={[agent({ deployment })]} />);
    expect(cellTexts('laptop-1')[4]).toBe(label);
  });

  it('renders each agent with its own slots and deployment', () => {
    render(
      <AgentTable
        agents={[
          agent({ id: 'laptop-1', deployment: 'local', active_slots: 1, capacity: 2 }),
          agent({ id: 'docker-1', deployment: 'self_hosted', agent_type: 'codex', active_slots: 4, capacity: 4, status: 'busy' }),
          agent({ id: 'cloud-1', deployment: 'hosted', active_slots: 0, capacity: null, status: 'offline', last_seen_at: null }),
        ]}
      />,
    );
    expect(cellTexts('laptop-1')).toEqual(['laptop-1', 'claude-code', '1 / 2', expect.stringMatching(/online/), 'Local', '5m ago']);
    expect(cellTexts('docker-1')).toEqual(['docker-1', 'codex', '4 / 4', expect.stringMatching(/busy/), 'Self-hosted', '5m ago']);
    expect(cellTexts('cloud-1')).toEqual(['cloud-1', 'claude-code', '0 / \u2014', expect.stringMatching(/offline/), 'Hosted', '\u2014']);
  });
});

describe('AgentTable behavior and safety', () => {
  it('navigates to the agent detail page when a row is clicked', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<AgentTable agents={[agent({ id: 'docker-1' })]} />);
    await user.click(rowFor('docker-1'));
    expect(router.push).toHaveBeenCalledWith('/agents/docker-1');
  });

  it('mentions no provider secret names or removed type names', () => {
    render(<AgentTable agents={[agent({ deployment: 'self_hosted' })]} />);
    const html = document.body.innerHTML.toLowerCase();
    for (const forbidden of FORBIDDEN_STRINGS) {
      expect(html, `UI must not mention ${forbidden}`).not.toContain(forbidden.toLowerCase());
    }
  });
});
