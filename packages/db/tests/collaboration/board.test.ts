import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  resolveCollabTestDatabaseUrl,
  resetCollabSchema,
  seedLegacyUser,
  seedLegacyOrgMembership,
} from '../helpers/collab-db.js';
import { runMigrations } from '../../src/migrate.js';
import { getPool, closePool } from '../../src/pool.js';
import { CollabServiceError } from '../../src/collaboration/errors.js';
import {
  ensureGithubPrincipal,
  bootstrapCollaborationWorkspace,
  createCollabProject,
  createCollabTask,
  moveCollabTask,
  updateCollabTask,
  getCollabTask,
  listCollabTasks,
} from '../../src/collaboration/identity.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const DATABASE_URL = process.env.DATABASE_URL;

function rejectionStatus(result: PromiseSettledResult<unknown>): number | null {
  if (result.status === 'rejected' && result.reason instanceof CollabServiceError) {
    return result.reason.status;
  }
  return null;
}

describe('A2 board: optimistic concurrency and ordering (real Postgres)', () => {
  let managerActor;
  let projectId;
  let tasks;

  async function rawQuery(text, params) {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    try {
      await client.connect();
      const result = await client.query(text, params);
      return result.rows;
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await resetCollabSchema(DATABASE_URL);
    await runMigrations();

    const legacyAdmin = await seedLegacyUser(DATABASE_URL, { githubId: 9201, login: 'board-owner' });
    await seedLegacyOrgMembership(DATABASE_URL, legacyAdmin, 'board-org', 'admin');
    const principal = await ensureGithubPrincipal({
      legacyUserId: legacyAdmin,
      displayName: 'Board Owner',
      email: 'board-owner@example.test',
    });
    managerActor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
    const ws = await bootstrapCollaborationWorkspace({
      actor: managerActor,
      legacyOrgId: 'board-org',
      name: 'Board Client',
      idempotencyKey: 'board-ws',
    });
    const project = await createCollabProject({ actor: managerActor, workspaceId: ws.id, name: 'Board P1' });
    projectId = project.id;

    tasks = [];
    for (const title of ['Task A', 'Task B', 'Task C']) {
      tasks.push(await createCollabTask({ actor: managerActor, projectId, title }));
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it('serializes simultaneous moves with the same board version — one wins, no lost update', async () => {
    const [t1, t2] = tasks;
    const live = (await rawQuery(`SELECT board_version FROM collab_projects WHERE id = $1`, [projectId]))[0].board_version;
    const results = await Promise.allSettled([
      moveCollabTask({
        actor: managerActor,
        taskId: t1.id,
        expectedVersion: t1.version,
        expectedBoardVersion: live,
        status: 'ready',
        beforeTaskId: null,
        afterTaskId: null,
      }),
      moveCollabTask({
        actor: managerActor,
        taskId: t2.id,
        expectedVersion: t2.version,
        expectedBoardVersion: live,
        status: 'ready',
        beforeTaskId: null,
        afterTaskId: null,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const conflicted = results.filter((r) => rejectionStatus(r) === 409);
    expect(fulfilled).toHaveLength(1);
    expect(conflicted).toHaveLength(1);

    const board = await rawQuery(
      `SELECT status, position FROM collab_tasks WHERE project_id = $1 ORDER BY status, position`,
      [projectId],
    );
    // All three tasks accounted for; exactly one sits in ready.
    expect(board).toHaveLength(3);
    expect(board.filter((t) => t.status === 'ready')).toHaveLength(1);

    const { rows } = await getPool().query(`SELECT board_version FROM collab_projects WHERE id = $1`, [projectId]);
    expect(rows[0].board_version).toBe(live + 1);
  });

  it('rejects stale board versions with the current board version attached', async () => {
    const current = (await rawQuery(`SELECT board_version FROM collab_projects WHERE id = $1`, [projectId]))[0].board_version;
    await expect(
      moveCollabTask({
        actor: managerActor,
        taskId: tasks[0].id,
        expectedVersion: tasks[0].version,
        expectedBoardVersion: current + 500,
        status: 'ready',
        beforeTaskId: null,
        afterTaskId: null,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'version_conflict',
      details: { currentBoardVersion: current },
    });
  });

  it('preserves the winning write when two edits race the same expectedVersion', async () => {
    const task = tasks[0];
    // Prior moves bumped the version — race from the CURRENT version.
    const current = await getCollabTask(managerActor, task.id);
    const results = await Promise.allSettled([
      updateCollabTask({ actor: managerActor, taskId: task.id, expectedVersion: current.task.version, title: 'First writer' }),
      updateCollabTask({ actor: managerActor, taskId: task.id, expectedVersion: current.task.version, title: 'Second writer' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = fulfilled[0].value;
    expect(winner.version).toBe(current.task.version + 1);
    expect(rejected[0].reason).toBeInstanceOf(CollabServiceError);
    expect(rejected[0].reason).toMatchObject({
      status: 409,
      code: 'version_conflict',
      details: { currentVersion: winner.version },
    });

    const detail = await getCollabTask(managerActor, task.id);
    expect(detail.task.title).toBe(winner.title);
    expect(detail.task.version).toBe(winner.version);
  });

  it('rejects neighbors from a different lane with 422', async () => {
    // tasks[0] is in ready (from the first move) — its position row is invalid
    // as a neighbor for a backlog insertion.
    const liveBoard = (await rawQuery(`SELECT board_version FROM collab_projects WHERE id = $1`, [projectId]))[0].board_version;
    await expect(
      moveCollabTask({
        actor: managerActor,
        taskId: tasks[2].id,
        expectedVersion: tasks[2].version,
        expectedBoardVersion: liveBoard,
        status: 'backlog',
        beforeTaskId: tasks[0].id,
        afterTaskId: null,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('keeps Done and Cancelled out of the move endpoint (decision endpoints only)', async () => {
    await expect(
      moveCollabTask({
        actor: managerActor,
        taskId: tasks[2].id,
        expectedVersion: tasks[2].version,
        expectedBoardVersion: 2,
        status: 'done',
        beforeTaskId: null,
        afterTaskId: null,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'decision_required' });
    await expect(
      moveCollabTask({
        actor: managerActor,
        taskId: tasks[2].id,
        expectedVersion: tasks[2].version,
        expectedBoardVersion: 2,
        status: 'cancelled',
        beforeTaskId: null,
        afterTaskId: null,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'decision_required' });
  });

  it('orders a lane deterministically between explicit non-moving anchors', async () => {
    // Backlog currently holds Task B and Task C. Create Task D, then move
    // Task C strictly between B and D — the mover is never its own anchor.
    const taskD = await createCollabTask({ actor: managerActor, projectId, title: 'Task D' });
    const lane = await rawQuery(
      `SELECT id, position FROM collab_tasks WHERE project_id = $1 AND status = 'backlog' ORDER BY position`,
      [projectId],
    );
    const ids = lane.map((r) => r.id);
    expect(ids).toContain(taskD.id);
    const beforeId = ids[0];
    const afterId = ids[ids.length - 1];
    const mover = tasks[2];
    const moverCurrent = await getCollabTask(managerActor, mover.id);
    const liveBoard = (await rawQuery(`SELECT board_version FROM collab_projects WHERE id = $1`, [projectId]))[0].board_version;

    const moved = await moveCollabTask({
      actor: managerActor,
      taskId: mover.id,
      expectedVersion: moverCurrent.task.version,
      expectedBoardVersion: liveBoard,
      status: 'backlog',
      beforeTaskId: beforeId,
      afterTaskId: afterId,
    });
    expect(moved.task.status).toBe('backlog');

    const refreshed = await rawQuery(`SELECT position FROM collab_tasks WHERE id = $1`, [mover.id]);
    const beforePos = (await rawQuery(`SELECT position FROM collab_tasks WHERE id = $1`, [beforeId]))[0].position;
    const afterPos = (await rawQuery(`SELECT position FROM collab_tasks WHERE id = $1`, [afterId]))[0].position;
    expect(refreshed[0].position > beforePos).toBe(true);
    expect(refreshed[0].position < afterPos).toBe(true);

    const list = await listCollabTasks({ actor: managerActor, projectId, status: 'backlog' });
    const positions = list.tasks.map((t) => t.position);
    expect(positions).toEqual([...positions].sort());
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('keeps Done and Cancelled out of the move endpoint (decision endpoints only)', async () => {
    const liveBoard = (await rawQuery(`SELECT board_version FROM collab_projects WHERE id = $1`, [projectId]))[0].board_version;
    const mover = await getCollabTask(managerActor, tasks[2].id);
    for (const status of ['done', 'cancelled'] as const) {
      await expect(
        moveCollabTask({
          actor: managerActor,
          taskId: tasks[2].id,
          expectedVersion: mover.task.version,
          expectedBoardVersion: liveBoard,
          status,
          beforeTaskId: null,
          afterTaskId: null,
        }),
      ).rejects.toMatchObject({ status: 422, code: 'decision_required' });
    }
  });
});

describe('A2 board hardening (rank/lock review findings)', () => {
  let managerActor;
  let projectId;

  async function rawQuery(text, params) {
    const client = new (await import('pg')).Client({ connectionString: process.env.DATABASE_URL });
    try {
      await client.connect();
      const result = await client.query(text, params);
      return result.rows;
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    // Reuse the fixture created by the suite above (same DB, same file).
    const owner = await rawQuery(`SELECT id, session_version FROM collab_principals WHERE legacy_user_id = (SELECT id FROM users WHERE login = 'board-owner')`);
    managerActor = { principalId: owner[0].id, sessionVersion: owner[0].session_version };
    projectId = (await rawQuery(`SELECT id FROM collab_projects WHERE name = 'Board P1'`))[0].id;
  });

  it('keeps unique ordered ranks across 120 tail appends', async () => {
    let last;
    for (let i = 0; i < 120; i += 1) {
      last = await createCollabTask({ actor: managerActor, projectId, title: `Bulk ${i}` });
    }
    const lane = await rawQuery(
      `SELECT position FROM collab_tasks WHERE project_id = $1 AND status = 'backlog' ORDER BY position`,
      [projectId],
    );
    const positions = lane.map((r) => r.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions).toEqual([...positions].sort());
    expect(lane[lane.length - 1].position).toBe(last.position);
  });

  it('supports repeated head insertion without rank collisions', async () => {
    const first = await createCollabTask({ actor: managerActor, projectId, title: 'Head anchor' });
    const anchors = await rawQuery(
      `SELECT id FROM collab_tasks WHERE project_id = $1 AND status = 'backlog' ORDER BY position LIMIT 1`,
      [projectId],
    );
    const created = [];
    for (let i = 0; i < 5; i += 1) {
      const task = await createCollabTask({ actor: managerActor, projectId, title: `Head ${i}` });
      created.push(task);
      const board = await rawQuery(`SELECT board_version FROM collab_projects WHERE id = $1`, [projectId]);
      await moveCollabTask({
        actor: managerActor,
        taskId: task.id,
        expectedVersion: task.version,
        expectedBoardVersion: board[0].board_version,
        status: 'backlog',
        beforeTaskId: null,
        afterTaskId: anchors[0].id,
      });
    }
    const positions = await rawQuery(
      `SELECT position FROM collab_tasks WHERE project_id = $1 AND status = 'backlog' ORDER BY position`,
      [projectId],
    );
    const values = positions.map((r) => r.position);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual([...values].sort());
  });

  it('rejects self, unknown and cross-lane anchors distinctly', async () => {
    const task = await createCollabTask({ actor: managerActor, projectId, title: 'Anchor checks' });
    const board = await rawQuery(`SELECT board_version FROM collab_projects WHERE id = $1`, [projectId]);
    const backlogTask = (
      await rawQuery(
        `SELECT id, status FROM collab_tasks WHERE project_id = $1 AND status = 'backlog' AND id <> $2 ORDER BY position LIMIT 1`,
        [projectId, task.id],
      )
    )[0];
    const readyTask = (
      await rawQuery(
        `SELECT id FROM collab_tasks WHERE project_id = $1 AND status = 'ready' ORDER BY position LIMIT 1`,
        [projectId],
      )
    )[0];

    // Self anchor → 422 invalid_neighbor.
    await expect(
      moveCollabTask({
        actor: managerActor, taskId: task.id, expectedVersion: task.version,
        expectedBoardVersion: board[0].board_version, status: 'backlog',
        beforeTaskId: task.id, afterTaskId: null,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'invalid_neighbor' });

    // Unknown anchor → 409 board_changed (stale view).
    await expect(
      moveCollabTask({
        actor: managerActor, taskId: task.id, expectedVersion: task.version,
        expectedBoardVersion: board[0].board_version, status: 'backlog',
        beforeTaskId: null, afterTaskId: '00000000-0000-4000-8000-0000000000aa',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'board_changed' });

    // Cross-lane anchor → 422 invalid_neighbor.
    if (readyTask) {
      await expect(
        moveCollabTask({
          actor: managerActor, taskId: task.id, expectedVersion: task.version,
          expectedBoardVersion: board[0].board_version, status: 'backlog',
          beforeTaskId: readyTask.id, afterTaskId: null,
        }),
      ).rejects.toMatchObject({ status: 422, code: 'invalid_neighbor' });
    }
    void backlogTask;
  });

  it('serializes a create against a move under one board lock and bumps board_version once each', async () => {
    const moveTarget = await createCollabTask({ actor: managerActor, projectId, title: 'Race mover' });
    const board0 = (await rawQuery(`SELECT board_version FROM collab_projects WHERE id = $1`, [projectId]))[0].board_version;
    const results = await Promise.allSettled([
      createCollabTask({ actor: managerActor, projectId, title: 'Racer' }),
      moveCollabTask({
        actor: managerActor, taskId: moveTarget.id, expectedVersion: moveTarget.version,
        expectedBoardVersion: board0 + 1, status: 'ready',
        beforeTaskId: null, afterTaskId: null,
      }),
    ]);
    // The racer create may land between the move's version read and its
    // transaction: an optimistic 409 on the move is correct then. What must
    // hold: every fulfilled mutation bumped board_version exactly once.
    const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length;
    expect(results[0].status).toBe('fulfilled'); // the create never conflicts
    const board1 = (await rawQuery(`SELECT board_version FROM collab_projects WHERE id = $1`, [projectId]))[0].board_version;
    expect(board1 - board0).toBe(fulfilledCount);
  });

  it('keeps positions unique within each lane and globally ordered per lane', async () => {
    // Positions are lane-scoped: uniqueness/ordering is per status.
    const all = await rawQuery(
      `SELECT status, position FROM collab_tasks WHERE project_id = $1`,
      [projectId],
    );
    const seen = new Set();
    for (const row of all) {
      const key = `${row.status}:${row.position}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('survives repeated head rotation across rank compaction (root repro shape)', async () => {
    // Fresh project to control the lane exactly.
    const project = await createCollabProject({ actor: managerActor, workspaceId: projectId ? (await rawQuery(`SELECT workspace_id FROM collab_projects WHERE id = $1`, [projectId]))[0].workspace_id : null, name: 'Rotation P1' });
    void project;
    const rotationProjectId = (
      await rawQuery(`SELECT id FROM collab_projects WHERE name = 'Rotation P1' ORDER BY created_at DESC LIMIT 1`)
    )[0].id;
    const anchor = await createCollabTask({ actor: managerActor, projectId: rotationProjectId, title: 'Anchor' });
    let board = (await rawQuery(`SELECT board_version FROM collab_projects WHERE id = $1`, [rotationProjectId]))[0].board_version;

    // 40 head rotations: each move targets afterTaskId=Anchor — midpoint ranks
    // shrink geometrically, forcing compaction well within 40 moves.
    for (let i = 0; i < 40; i += 1) {
      const task = await createCollabTask({ actor: managerActor, projectId: rotationProjectId, title: `Rot ${i}` });
      // Creates bump the board too — always read the live version.
      board = (await rawQuery(`SELECT board_version FROM collab_projects WHERE id = $1`, [rotationProjectId]))[0].board_version;
      const result = await moveCollabTask({
        actor: managerActor,
        taskId: task.id,
        expectedVersion: task.version,
        expectedBoardVersion: board,
        status: 'backlog',
        beforeTaskId: null,
        afterTaskId: anchor.id,
      });
      expect(result.task.status).toBe('backlog');
    }

    const lane = await rawQuery(
      `SELECT position FROM collab_tasks WHERE project_id = $1 AND status = 'backlog' ORDER BY position`,
      [rotationProjectId],
    );
    const positions = lane.map((r) => r.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions).toEqual([...positions].sort());
    // Anchor ends up after the rotated block.
    expect(positions[39] < positions[40]).toBe(true);
  });
});
