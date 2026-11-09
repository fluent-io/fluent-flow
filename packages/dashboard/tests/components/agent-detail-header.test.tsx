import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
