import { describe, it, expect } from 'vitest';
import { agentDetailSchema, agentListItemSchema, agentSchema } from '../../src/schemas/agents';

function listItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'portable-1',
    org_id: 'fluent-io',
    agent_type: 'codex',
    transport: 'long_poll',
    transport_meta: { provider: 'codex', capacity: 4, deployment: 'self_hosted' },
    repos: [],
    max_chat_slots: null,
    created_at: new Date('2026-11-08T12:00:00.000Z'),
    updated_at: new Date('2026-11-08T12:00:00.000Z'),
    status: 'online',
    last_seen_at: new Date('2026-11-08T12:05:00.000Z'),
    deployment: 'self_hosted',
    capacity: 4,
    active_slots: 2,
    busy_chat: 0,
    busy_work: 0,
    ...overrides,
  };
}

describe('agentListItemSchema capacity visibility', () => {
  it('keeps deployment, capacity and active_slots on the parsed DTO', () => {
    const parsed = agentListItemSchema.parse(listItem());

    expect(parsed.deployment).toBe('self_hosted');
    expect(parsed.capacity).toBe(4);
    expect(parsed.active_slots).toBe(2);
  });

  it.each(['local', 'self_hosted', 'hosted'])('accepts %s deployment', (deployment) => {
    expect(agentListItemSchema.parse(listItem({ deployment })).deployment).toBe(deployment);
  });

  it('accepts an agent with no deployment and no capacity yet', () => {
    const parsed = agentListItemSchema.parse(listItem({ deployment: null, capacity: null, active_slots: 0 }));

    expect(parsed.deployment).toBeNull();
    expect(parsed.capacity).toBeNull();
    expect(parsed.active_slots).toBe(0);
  });

  it.each(['cloud', 'LOCAL', '', 'docker'])('rejects unknown deployment %j', (deployment) => {
    expect(() => agentListItemSchema.parse(listItem({ deployment }))).toThrow();
  });

  it.each([1.5, 0.5, Number.NaN])('rejects non-integer capacity %j', (capacity) => {
    expect(() => agentListItemSchema.parse(listItem({ capacity }))).toThrow();
  });

  it.each([-1, 1.5, null, undefined])('rejects invalid active_slots %j', (active_slots) => {
    expect(() => agentListItemSchema.parse(listItem({ active_slots }))).toThrow();
  });
});

describe('agentSchema', () => {
  it('still parses a freshly inserted agent row that has no aggregate columns', () => {
    const { deployment: _deployment, capacity: _capacity, active_slots: _activeSlots, ...row } = listItem();

    expect(agentSchema.parse(row).id).toBe('portable-1');
  });
});

describe('agentDetailSchema status visibility', () => {
  it.each(['busy', 'online', 'offline'])('keeps %s status and last_seen_at on the parsed detail DTO', (status) => {
    const seen = new Date('2026-11-08T12:05:00.000Z');
    const parsed = agentDetailSchema.parse(listItem({ status, last_seen_at: seen }));

    expect(parsed.status).toBe(status);
    expect(parsed.last_seen_at).toEqual(seen);
  });

  it('accepts a never-connected agent with offline status and null last_seen_at', () => {
    const parsed = agentDetailSchema.parse(listItem({ status: 'offline', last_seen_at: null }));

    expect(parsed.status).toBe('offline');
    expect(parsed.last_seen_at).toBeNull();
  });

  it('coerces a last_seen_at timestamp string to a Date', () => {
    const parsed = agentDetailSchema.parse(listItem({ last_seen_at: '2026-11-08T12:05:00.000Z' }));

    expect(parsed.last_seen_at).toEqual(new Date('2026-11-08T12:05:00.000Z'));
  });

  it('rejects a detail row without status', () => {
    expect(() => agentDetailSchema.parse(listItem({ status: undefined }))).toThrow();
  });
});
