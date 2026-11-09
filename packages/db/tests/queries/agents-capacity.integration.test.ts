import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgentDetail, listAgents } from '../../src/queries/index.js';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import type { AgentListItem } from '../../src/schemas/agents.js';
import {
  resetCollabSchema,
  resolveCollabTestDatabaseUrl,
} from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const orgA = 'capacity-org-a';
const orgB = 'capacity-org-b';

interface SessionSeed {
  status: string;
  meta?: Record<string, unknown>;
  lastSeenSecondsAgo: number;
  expiresInSeconds: number;
}

async function insertAgent(
  orgId: string,
  id: string,
  transportMeta: Record<string, unknown> = {},
) {
  await getPool().query(
    `INSERT INTO agents (id, org_id, agent_type, transport, transport_meta)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, orgId, 'codex', 'long_poll', transportMeta],
  );
}

async function insertSession(orgId: string, agentId: string, seed: SessionSeed) {
  await getPool().query(
    `INSERT INTO agent_sessions (org_id, agent_id, session_meta, status, last_seen_at, expires_at)
     VALUES ($1, $2, $3, $4, NOW() - make_interval(secs => $5::int), NOW() + make_interval(secs => $6::int))`,
    [orgId, agentId, seed.meta ?? {}, seed.status, seed.lastSeenSecondsAgo, seed.expiresInSeconds],
  );
}

describe('agent capacity aggregation (real Postgres)', () => {
  beforeAll(async () => {
    await resetCollabSchema(databaseUrl);
    await runMigrations();
    const pool = getPool();
    await pool.query('INSERT INTO orgs (id, name) VALUES ($1, $2), ($3, $4)', [
      orgA, 'Capacity A', orgB, 'Capacity B',
    ]);

    await insertAgent(orgA, 'busy-agent', { provider: 'codex', capacity: 4, deployment: 'local' });
    await insertSession(orgA, 'busy-agent', {
      status: 'busy',
      meta: { slot_id: 1, capacity: 6, deployment: 'self_hosted' },
      lastSeenSecondsAgo: 5,
      expiresInSeconds: 300,
    });
    await insertSession(orgA, 'busy-agent', {
      status: 'online',
      meta: { slot_id: 2, capacity: 5, deployment: 'local' },
      lastSeenSecondsAgo: 30,
      expiresInSeconds: 300,
    });
    await insertSession(orgA, 'busy-agent', {
      status: 'online',
      meta: { slot_id: 3, capacity: 9, deployment: 'hosted' },
      lastSeenSecondsAgo: 1,
      expiresInSeconds: -60,
    });
    await insertSession(orgA, 'busy-agent', {
      status: 'offline',
      meta: { slot_id: 4, capacity: 12, deployment: 'hosted' },
      lastSeenSecondsAgo: 2,
      expiresInSeconds: 300,
    });

    await insertAgent(orgA, 'online-agent', { provider: 'codex', capacity: 2, deployment: 'self_hosted' });
    await insertSession(orgA, 'online-agent', {
      status: 'online',
      meta: { slot_id: 1 },
      lastSeenSecondsAgo: 10,
      expiresInSeconds: 300,
    });

    await insertAgent(orgA, 'offline-agent', { provider: 'codex', capacity: 3, deployment: 'local' });
    await insertSession(orgA, 'offline-agent', {
      status: 'online',
      meta: { slot_id: 1, capacity: 8, deployment: 'hosted' },
      lastSeenSecondsAgo: 600,
      expiresInSeconds: -300,
    });

    await insertAgent(orgA, 'never-seen-agent');

    await insertAgent(orgA, 'ttl-agent', { provider: 'codex', capacity: 1, deployment: 'local' });
    await insertSession(orgA, 'ttl-agent', {
      status: 'online',
      meta: { slot_id: 1 },
      lastSeenSecondsAgo: 1,
      expiresInSeconds: 300,
    });

    await insertAgent(orgB, 'busy-agent', { provider: 'claude-code', capacity: 1, deployment: 'local' });
    await insertSession(orgB, 'busy-agent', {
      status: 'online',
      meta: { slot_id: 1, capacity: 1 },
      lastSeenSecondsAgo: 3,
      expiresInSeconds: 300,
    });
  });

  afterAll(async () => {
    await closePool();
  });

  function pick(agents: AgentListItem[], orgId: string, id: string) {
    const found = agents.find((agent) => agent.org_id === orgId && agent.id === id);
    if (!found) throw new Error(`agent ${orgId}/${id} missing from list`);
    return found;
  }

  it('counts only live slots, reports busy, and takes capacity and deployment from the latest live slot', async () => {
    const agent = pick(await listAgents([orgA]), orgA, 'busy-agent');

    expect(agent.active_slots).toBe(2);
    expect(agent.status).toBe('busy');
    expect(agent.capacity).toBe(6);
    expect(agent.deployment).toBe('self_hosted');
  });

  it('reports online and falls back to configured capacity and deployment when live slots omit them', async () => {
    const agent = pick(await listAgents([orgA]), orgA, 'online-agent');

    expect(agent.active_slots).toBe(1);
    expect(agent.status).toBe('online');
    expect(agent.capacity).toBe(2);
    expect(agent.deployment).toBe('self_hosted');
  });

  it('reports offline with zero slots and configured capacity when every session has expired', async () => {
    const agent = pick(await listAgents([orgA]), orgA, 'offline-agent');

    expect(agent.active_slots).toBe(0);
    expect(agent.status).toBe('offline');
    expect(agent.capacity).toBe(3);
    expect(agent.deployment).toBe('local');
    expect(agent.last_seen_at).toBeInstanceOf(Date);
  });

  it('reports offline with null capacity and deployment for an agent that never connected', async () => {
    const agent = pick(await listAgents([orgA]), orgA, 'never-seen-agent');

    expect(agent.active_slots).toBe(0);
    expect(agent.status).toBe('offline');
    expect(agent.capacity).toBeNull();
    expect(agent.deployment).toBeNull();
    expect(agent.last_seen_at).toBeNull();
  });

  it('does not mix same-named agents across organizations', async () => {
    const scopedA = await listAgents([orgA]);
    const scopedB = await listAgents([orgB]);

    expect(scopedA.every((agent) => agent.org_id === orgA)).toBe(true);
    expect(scopedB.map((agent) => `${agent.org_id}/${agent.id}`)).toEqual([`${orgB}/busy-agent`]);
    expect(pick(scopedA, orgA, 'busy-agent').active_slots).toBe(2);
    const b = pick(scopedB, orgB, 'busy-agent');
    expect(b.active_slots).toBe(1);
    expect(b.status).toBe('online');
    expect(b.capacity).toBe(1);
    expect(b.deployment).toBe('local');
  });

  it('keeps per-organization counts for explicit superadmin listing', async () => {
    const all = await listAgents([], true);

    expect(pick(all, orgA, 'busy-agent').active_slots).toBe(2);
    expect(pick(all, orgB, 'busy-agent').active_slots).toBe(1);
  });

  it('returns no rows for an empty non-superadmin scope', async () => {
    await expect(listAgents([])).resolves.toEqual([]);
  });

  it('returns the same aggregate on the detail DTO and respects organization scope', async () => {
    const detail = await getAgentDetail([orgA], 'busy-agent');
    expect(detail).toEqual(expect.objectContaining({
      org_id: orgA,
      id: 'busy-agent',
      active_slots: 2,
      capacity: 6,
      deployment: 'self_hosted',
    }));

    const other = await getAgentDetail([orgB], 'busy-agent');
    expect(other).toEqual(expect.objectContaining({
      org_id: orgB,
      active_slots: 1,
      capacity: 1,
      deployment: 'local',
    }));

    await expect(getAgentDetail([orgB], 'online-agent')).resolves.toBeNull();
  });

  it('detail falls back to configured values and zero slots when nothing is live', async () => {
    const detail = await getAgentDetail([orgA], 'offline-agent');
    expect(detail).toEqual(expect.objectContaining({ active_slots: 0, capacity: 3, deployment: 'local' }));

    const never = await getAgentDetail([orgA], 'never-seen-agent');
    expect(never).toEqual(expect.objectContaining({ active_slots: 0, capacity: null, deployment: null }));
  });

  it('stops counting a slot as soon as its TTL elapses without any write to the stored status', async () => {
    const before = pick(await listAgents([orgA]), orgA, 'ttl-agent');
    expect(before.active_slots).toBe(1);
    expect(before.status).toBe('online');

    await getPool().query(
      `UPDATE agent_sessions SET expires_at = NOW() - interval '1 second'
       WHERE org_id = $1 AND agent_id = $2`,
      [orgA, 'ttl-agent'],
    );

    const after = pick(await listAgents([orgA]), orgA, 'ttl-agent');
    expect(after.active_slots).toBe(0);
    expect(after.status).toBe('offline');
    expect(after.capacity).toBe(1);

    const stored = await getPool().query(
      'SELECT status FROM agent_sessions WHERE org_id = $1 AND agent_id = $2',
      [orgA, 'ttl-agent'],
    );
    expect(stored.rows[0].status).toBe('online');
    const detail = await getAgentDetail([orgA], 'ttl-agent');
    expect(detail?.active_slots).toBe(0);
  });

  describe('hardened aggregation', () => {
    const orgC = 'capacity-org-c';
    const orgD = 'capacity-org-d';
    const poisonCapacities: unknown[] = ['abc', 0, 99, -3, 1.5, { value: 4 }, true];
    const poisonDeployments: unknown[] = ['docker', 7, { value: 'local' }];

    interface Expectation {
      id: string;
      capacity: number | null;
      deployment: string | null;
      active_slots: number;
    }

    const poisonExpectations: Expectation[] = [];

    async function insertSessionAt(
      orgId: string,
      agentId: string,
      seed: { status: string; meta: Record<string, unknown>; lastSeenAt: Date },
    ) {
      await getPool().query(
        `INSERT INTO agent_sessions (org_id, agent_id, session_meta, status, last_seen_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + interval '300 seconds')`,
        [orgId, agentId, seed.meta, seed.status, seed.lastSeenAt],
      );
    }

    function live(meta: Record<string, unknown>, lastSeenSecondsAgo = 5, status = 'online'): SessionSeed {
      return { status, meta, lastSeenSecondsAgo, expiresInSeconds: 300 };
    }

    beforeAll(async () => {
      await getPool().query('INSERT INTO orgs (id, name) VALUES ($1, $2), ($3, $4)', [
        orgC, 'Capacity C', orgD, 'Capacity D',
      ]);

      for (const [index, poison] of poisonCapacities.entries()) {
        const sessionPoisoned = `poison-session-capacity-${index}`;
        await insertAgent(orgC, sessionPoisoned, { capacity: 3, deployment: 'local' });
        await insertSession(orgC, sessionPoisoned, live({
          instance_id: `inst-${index}`, slot_id: 0, capacity: poison, deployment: 'hosted',
        }));
        poisonExpectations.push({ id: sessionPoisoned, capacity: 3, deployment: 'hosted', active_slots: 1 });

        const configPoisoned = `poison-config-capacity-${index}`;
        await insertAgent(orgC, configPoisoned, { capacity: poison, deployment: 'local' });
        await insertSession(orgC, configPoisoned, live({
          instance_id: `inst-${index}`, slot_id: 0, capacity: 5,
        }));
        poisonExpectations.push({ id: configPoisoned, capacity: 5, deployment: 'local', active_slots: 1 });

        const configPoisonedUnreported = `poison-config-capacity-unreported-${index}`;
        await insertAgent(orgC, configPoisonedUnreported, { capacity: poison, deployment: 'local' });
        await insertSession(orgC, configPoisonedUnreported, live({ instance_id: `inst-${index}`, slot_id: 0 }));
        poisonExpectations.push({ id: configPoisonedUnreported, capacity: null, deployment: 'local', active_slots: 1 });

        const bothPoisoned = `poison-both-capacity-${index}`;
        await insertAgent(orgC, bothPoisoned, { capacity: poison, deployment: 'local' });
        await insertSession(orgC, bothPoisoned, live({
          instance_id: `inst-${index}`, slot_id: 0, capacity: poison,
        }));
        poisonExpectations.push({ id: bothPoisoned, capacity: null, deployment: 'local', active_slots: 1 });
      }

      for (const [index, poison] of poisonDeployments.entries()) {
        const sessionPoisoned = `poison-session-deployment-${index}`;
        await insertAgent(orgC, sessionPoisoned, { capacity: 2, deployment: 'self_hosted' });
        await insertSession(orgC, sessionPoisoned, live({
          instance_id: `inst-${index}`, slot_id: 0, capacity: 2, deployment: poison,
        }));
        poisonExpectations.push({ id: sessionPoisoned, capacity: 2, deployment: 'self_hosted', active_slots: 1 });

        const configPoisoned = `poison-config-deployment-${index}`;
        await insertAgent(orgC, configPoisoned, { capacity: 2, deployment: poison });
        await insertSession(orgC, configPoisoned, live({
          instance_id: `inst-${index}`, slot_id: 0, capacity: 2, deployment: 'hosted',
        }));
        poisonExpectations.push({ id: configPoisoned, capacity: 2, deployment: 'hosted', active_slots: 1 });

        const configPoisonedUnreported = `poison-config-deployment-unreported-${index}`;
        await insertAgent(orgC, configPoisonedUnreported, { capacity: 2, deployment: poison });
        await insertSession(orgC, configPoisonedUnreported, live({
          instance_id: `inst-${index}`, slot_id: 0, capacity: 2,
        }));
        poisonExpectations.push({ id: configPoisonedUnreported, capacity: 2, deployment: null, active_slots: 1 });

        const bothPoisoned = `poison-both-deployment-${index}`;
        await insertAgent(orgC, bothPoisoned, { capacity: 2, deployment: poison });
        await insertSession(orgC, bothPoisoned, live({
          instance_id: `inst-${index}`, slot_id: 0, capacity: 2, deployment: poison,
        }));
        poisonExpectations.push({ id: bothPoisoned, capacity: 2, deployment: null, active_slots: 1 });
      }

      await insertAgent(orgC, 'poison-newest-slot', { capacity: 2, deployment: 'local' });
      await insertSession(orgC, 'poison-newest-slot', live({
        instance_id: 'inst-newest', slot_id: 0, capacity: 'abc', deployment: 'docker',
      }, 5));
      await insertSession(orgC, 'poison-newest-slot', live({
        instance_id: 'inst-newest', slot_id: 1, capacity: 4, deployment: 'hosted',
      }, 30));
      poisonExpectations.push({ id: 'poison-newest-slot', capacity: 4, deployment: 'hosted', active_slots: 2 });

      await insertAgent(orgD, 'restart-overlap', { capacity: 8, deployment: 'local' });
      await insertSession(orgD, 'restart-overlap', live({
        instance_id: 'inst-r', slot_id: 0, capacity: 2, deployment: 'local',
      }, 40));
      await insertSession(orgD, 'restart-overlap', live({
        instance_id: 'inst-r', slot_id: 0, capacity: 2, deployment: 'local',
      }, 5));
      await insertSession(orgD, 'restart-overlap', live({
        instance_id: 'inst-r', slot_id: 1, capacity: 2, deployment: 'local',
      }, 6));

      await insertAgent(orgD, 'two-instances-online', { capacity: 2, deployment: 'local' });
      for (const instance of ['inst-a', 'inst-b']) {
        for (const slot of [0, 1]) {
          await insertSession(orgD, 'two-instances-online', live({
            instance_id: instance, slot_id: slot, capacity: 2, deployment: 'local',
          }, 10 + slot));
        }
      }

      await insertAgent(orgD, 'two-instances-busy', { capacity: 2, deployment: 'local' });
      await insertSession(orgD, 'two-instances-busy', live({
        instance_id: 'inst-a', slot_id: 0, capacity: 2, deployment: 'local',
      }, 60, 'busy'));
      await insertSession(orgD, 'two-instances-busy', live({
        instance_id: 'inst-a', slot_id: 1, capacity: 2, deployment: 'local',
      }, 50));
      await insertSession(orgD, 'two-instances-busy', live({
        instance_id: 'inst-b', slot_id: 0, capacity: 2, deployment: 'local',
      }, 5));
      await insertSession(orgD, 'two-instances-busy', live({
        instance_id: 'inst-b', slot_id: 1, capacity: 2, deployment: 'local',
      }, 6));

      await insertAgent(orgD, 'instance-latest-capacity', { capacity: 1, deployment: 'local' });
      await insertSession(orgD, 'instance-latest-capacity', live({
        instance_id: 'inst-a', slot_id: 0, capacity: 4, deployment: 'local',
      }, 40));
      await insertSession(orgD, 'instance-latest-capacity', live({
        instance_id: 'inst-a', slot_id: 1, capacity: 2, deployment: 'local',
      }, 5));
      await insertSession(orgD, 'instance-latest-capacity', live({
        instance_id: 'inst-b', slot_id: 0, capacity: 3, deployment: 'local',
      }, 8));

      await insertAgent(orgD, 'legacy-only', { capacity: 4, deployment: 'self_hosted' });
      await insertSession(orgD, 'legacy-only', live({}, 10));
      await insertSession(orgD, 'legacy-only', live({ slot_id: 0 }, 11));
      await insertSession(orgD, 'legacy-only', live({ slot_id: 0 }, 12));

      await insertAgent(orgD, 'legacy-mixed', { capacity: 4, deployment: 'self_hosted' });
      await insertSession(orgD, 'legacy-mixed', live({
        instance_id: 'inst-m', slot_id: 0, capacity: 2, deployment: 'self_hosted',
      }, 30));
      await insertSession(orgD, 'legacy-mixed', live({
        instance_id: 'inst-m', slot_id: 0, capacity: 2, deployment: 'self_hosted',
      }, 5));
      await insertSession(orgD, 'legacy-mixed', live({}, 10));
      await insertSession(orgD, 'legacy-mixed', live({ slot_id: 0 }, 11));

      const tieTime = new Date(Date.now() - 20_000);
      await insertAgent(orgD, 'tie-high-id-small-capacity', { capacity: 1, deployment: 'local' });
      await insertSessionAt(orgD, 'tie-high-id-small-capacity', {
        status: 'online',
        meta: { instance_id: 'inst-t', slot_id: 0, capacity: 5, deployment: 'hosted' },
        lastSeenAt: tieTime,
      });
      await insertSessionAt(orgD, 'tie-high-id-small-capacity', {
        status: 'online',
        meta: { instance_id: 'inst-t', slot_id: 1, capacity: 3, deployment: 'local' },
        lastSeenAt: tieTime,
      });

      await insertAgent(orgD, 'tie-high-id-large-capacity', { capacity: 1, deployment: 'local' });
      await insertSessionAt(orgD, 'tie-high-id-large-capacity', {
        status: 'online',
        meta: { instance_id: 'inst-t', slot_id: 0, capacity: 3, deployment: 'local' },
        lastSeenAt: tieTime,
      });
      await insertSessionAt(orgD, 'tie-high-id-large-capacity', {
        status: 'online',
        meta: { instance_id: 'inst-t', slot_id: 1, capacity: 5, deployment: 'hosted' },
        lastSeenAt: tieTime,
      });

      await insertAgent(orgD, 'detail-busy-older', { capacity: 2, deployment: 'local' });
      await insertSession(orgD, 'detail-busy-older', live({
        instance_id: 'inst-d', slot_id: 0, capacity: 2, deployment: 'local',
      }, 90, 'busy'));
      await insertSession(orgD, 'detail-busy-older', live({
        instance_id: 'inst-d', slot_id: 1, capacity: 2, deployment: 'local',
      }, 4));
    }, 120_000);

    it('ignores poisoned capacity and deployment metadata in the list without failing the page', async () => {
      const agents = await listAgents([orgC]);

      expect(agents).toHaveLength(poisonExpectations.length);
      for (const expected of poisonExpectations) {
        const agent = pick(agents, orgC, expected.id);
        expect(
          { capacity: agent.capacity, deployment: agent.deployment, active_slots: agent.active_slots, status: agent.status },
          expected.id,
        ).toEqual({
          capacity: expected.capacity,
          deployment: expected.deployment,
          active_slots: expected.active_slots,
          status: 'online',
        });
      }
    }, 30_000);

    it('ignores poisoned capacity and deployment metadata in the detail DTO', async () => {
      for (const expected of poisonExpectations) {
        const detail = await getAgentDetail([orgC], expected.id);
        expect(
          detail && { capacity: detail.capacity, deployment: detail.deployment, active_slots: detail.active_slots },
          expected.id,
        ).toEqual({
          capacity: expected.capacity,
          deployment: expected.deployment,
          active_slots: expected.active_slots,
        });
      }
    }, 60_000);

    it('collapses a restart overlap of two live rows for the same instance and slot into one slot', async () => {
      const agent = pick(await listAgents([orgD]), orgD, 'restart-overlap');
      expect(agent.active_slots).toBe(2);
      expect(agent.capacity).toBe(2);

      const detail = await getAgentDetail([orgD], 'restart-overlap');
      expect(detail?.active_slots).toBe(2);
      expect(detail?.capacity).toBe(2);
    });

    it('sums capacity over distinct live instances and counts the same slot id once per instance', async () => {
      const agent = pick(await listAgents([orgD]), orgD, 'two-instances-online');
      expect(agent.active_slots).toBe(4);
      expect(agent.capacity).toBe(4);
      expect(agent.status).toBe('online');

      const detail = await getAgentDetail([orgD], 'two-instances-online');
      expect(detail).toEqual(expect.objectContaining({ active_slots: 4, capacity: 4, status: 'online' }));
    });

    it('reports busy when one instance is busy and another is online', async () => {
      const agent = pick(await listAgents([orgD]), orgD, 'two-instances-busy');
      expect(agent.active_slots).toBe(4);
      expect(agent.capacity).toBe(4);
      expect(agent.status).toBe('busy');

      const detail = await getAgentDetail([orgD], 'two-instances-busy');
      expect(detail).toEqual(expect.objectContaining({ active_slots: 4, capacity: 4, status: 'busy' }));
    });

    it('uses the latest live reported capacity of each instance when summing', async () => {
      const agent = pick(await listAgents([orgD]), orgD, 'instance-latest-capacity');
      expect(agent.active_slots).toBe(3);
      expect(agent.capacity).toBe(5);

      const detail = await getAgentDetail([orgD], 'instance-latest-capacity');
      expect(detail).toEqual(expect.objectContaining({ active_slots: 3, capacity: 5 }));
    });

    it('counts live rows without instance metadata individually and uses configured capacity for them', async () => {
      const agent = pick(await listAgents([orgD]), orgD, 'legacy-only');
      expect(agent.active_slots).toBe(3);
      expect(agent.capacity).toBe(4);
      expect(agent.deployment).toBe('self_hosted');

      const detail = await getAgentDetail([orgD], 'legacy-only');
      expect(detail).toEqual(expect.objectContaining({ active_slots: 3, capacity: 4 }));
    });

    it('counts legacy rows individually next to a restart-overlapped instance slot', async () => {
      const agent = pick(await listAgents([orgD]), orgD, 'legacy-mixed');
      expect(agent.active_slots).toBe(3);

      const detail = await getAgentDetail([orgD], 'legacy-mixed');
      expect(detail?.active_slots).toBe(3);
    });

    it('breaks last_seen_at ties deterministically in favour of the higher session id', async () => {
      const agents = await listAgents([orgD]);
      const smallLast = pick(agents, orgD, 'tie-high-id-small-capacity');
      const largeLast = pick(agents, orgD, 'tie-high-id-large-capacity');

      expect(smallLast.capacity).toBe(3);
      expect(smallLast.deployment).toBe('local');
      expect(largeLast.capacity).toBe(5);
      expect(largeLast.deployment).toBe('hosted');

      const detailSmall = await getAgentDetail([orgD], 'tie-high-id-small-capacity');
      const detailLarge = await getAgentDetail([orgD], 'tie-high-id-large-capacity');
      expect(detailSmall).toEqual(expect.objectContaining({ capacity: 3, deployment: 'local' }));
      expect(detailLarge).toEqual(expect.objectContaining({ capacity: 5, deployment: 'hosted' }));
    });

    it('returns status and last_seen_at on the detail DTO with the list aggregate semantics', async () => {
      const detail = await getAgentDetail([orgD], 'detail-busy-older');
      const seen = await getPool().query(
        'SELECT max(last_seen_at) AS seen FROM agent_sessions WHERE org_id = $1 AND agent_id = $2',
        [orgD, 'detail-busy-older'],
      );

      expect(detail).toEqual(expect.objectContaining({ status: 'busy', active_slots: 2 }));
      expect(detail?.last_seen_at).toBeInstanceOf(Date);
      expect(detail?.last_seen_at?.getTime()).toBe(seen.rows[0].seen.getTime());

      const list = pick(await listAgents([orgD]), orgD, 'detail-busy-older');
      expect(detail?.status).toBe(list.status);
      expect(detail?.last_seen_at?.getTime()).toBe(list.last_seen_at?.getTime());
    });

    it('returns online status on detail for a plain live agent', async () => {
      const detail = await getAgentDetail([orgA], 'online-agent');

      expect(detail?.status).toBe('online');
      expect(detail?.last_seen_at).toBeInstanceOf(Date);
    });

    it('returns offline status with the last seen time on detail when every session expired', async () => {
      const detail = await getAgentDetail([orgA], 'offline-agent');

      expect(detail?.status).toBe('offline');
      expect(detail?.last_seen_at).toBeInstanceOf(Date);
    });

    it('returns offline status with null last_seen_at on detail for a never-connected agent', async () => {
      const detail = await getAgentDetail([orgA], 'never-seen-agent');

      expect(detail?.status).toBe('offline');
      expect(detail?.last_seen_at).toBeNull();
    });
  });
});
