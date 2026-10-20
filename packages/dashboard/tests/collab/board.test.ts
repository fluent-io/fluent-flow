import { describe, it, expect } from 'vitest';
import type { Task } from '../../src/lib/collab/types';

const { buildMoveRequest, applyBoardMove, canDropOnCard, moveTargetForDrop } = await import('../../src/lib/collab/board');

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    projectId: 'p1',
    title: `Task ${overrides.id}`,
    description: '',
    status: 'backlog',
    priority: 'normal',
    assigneeId: null,
    version: 1,
    position: '1000',
    blockedReason: null,
    createdAt: '2026-10-19T00:00:00Z',
    updatedAt: '2026-10-19T00:00:00Z',
    ...overrides,
  };
}

describe('buildMoveRequest', () => {
  const lane = [task({ id: 'a', position: '1000' }), task({ id: 'b', position: '2000' }), task({ id: 'c', position: '3000' })];

  it('targets the lane top when no neighbors are given', () => {
    const move = buildMoveRequest(lane, 'ready', { moving: task({ id: 'a', version: 4 }) });
    expect(move).toEqual({ status: 'ready', beforeTaskId: null, afterTaskId: 'a', projectId: 'p1' });
  });

  it('inserts between neighbors', () => {
    const move = buildMoveRequest(lane, 'backlog', {
      moving: task({ id: 'a' }),
      beforeTaskId: 'a',
      afterTaskId: 'b',
    });
    expect(move).toEqual({ status: 'backlog', beforeTaskId: 'a', afterTaskId: 'b', projectId: 'p1' });
  });

  it('targets the lane bottom after the last card', () => {
    const move = buildMoveRequest(lane, 'backlog', {
      moving: task({ id: 'a' }),
      beforeTaskId: 'c',
      afterTaskId: null,
    });
    expect(move).toEqual({ status: 'backlog', beforeTaskId: 'c', afterTaskId: null, projectId: 'p1' });
  });
});

describe('applyBoardMove', () => {
  it('relocates the task into the target lane at the requested spot', () => {
    const tasks = [
      task({ id: 'a', status: 'backlog', position: '1000' }),
      task({ id: 'b', status: 'backlog', position: '2000' }),
      task({ id: 'x', status: 'ready', position: '1000' }),
    ];
    const updated = applyBoardMove(tasks, 'b', {
      status: 'ready',
      beforeTaskId: null,
      afterTaskId: 'x',
    });
    const moved = updated.find((t) => t.id === 'b');
    expect(moved?.status).toBe('ready');
    // Lane order is the resulting server array order; no client re-ranking.
    expect(updated.filter((t) => t.status === 'ready').map((t) => t.id)).toEqual(['b', 'x']);
  });

  it('preserves the server-provided array order instead of ranking opaque positions numerically', () => {
    // Opaque ranks: lexicographic or numeric comparisons are both meaningless.
    const tasks = [
      task({ id: 'm', status: 'backlog', position: '900', projectId: 'p1' }),
      task({ id: 's1', status: 'ready', position: 'a.25', projectId: 'p1' }),
      task({ id: 's2', status: 'ready', position: '0.5', projectId: 'p1' }),
    ];
    const updated = applyBoardMove(tasks, 'm', {
      status: 'ready',
      beforeTaskId: 's1',
      afterTaskId: null,
      projectId: 'p1',
    });
    expect(updated.filter((t) => t.status === 'ready').map((t) => t.id)).toEqual(['s1', 'm', 's2']);
  });

  it('scopes moves to the moving task project and never splices against foreign-project neighbors', () => {
    const tasks = [
      task({ id: 'm', status: 'backlog', position: '900', projectId: 'p1' }),
      task({ id: 'foreign', status: 'ready', position: '100', projectId: 'p2' }),
      task({ id: 'mine', status: 'ready', position: '200', projectId: 'p1' }),
    ];
    const updated = applyBoardMove(tasks, 'm', {
      status: 'ready',
      beforeTaskId: null,
      afterTaskId: 'foreign',
      projectId: 'p1',
    });
    const readyIds = updated.filter((t) => t.status === 'ready').map((t) => t.id);
    // 'foreign' is another project's card: it must not receive the moved card.
    expect(readyIds).toEqual(['foreign', 'm', 'mine']);
    expect(updated.find((t) => t.id === 'foreign')?.projectId).toBe('p2');
  });

  it('keeps two projects accepted moves independent when applied in sequence', () => {
    const tasks = [
      task({ id: 'a1', status: 'backlog', position: '100', projectId: 'p1' }),
      task({ id: 'b1', status: 'backlog', position: '100', projectId: 'p2' }),
    ];
    const afterFirst = applyBoardMove(tasks, 'a1', {
      status: 'in_progress',
      beforeTaskId: null,
      afterTaskId: null,
      projectId: 'p1',
    });
    const afterSecond = applyBoardMove(afterFirst, 'b1', {
      status: 'ready',
      beforeTaskId: null,
      afterTaskId: null,
      projectId: 'p2',
    });
    expect(afterSecond.find((t) => t.id === 'a1')?.status).toBe('in_progress');
    expect(afterSecond.find((t) => t.id === 'b1')?.status).toBe('ready');
    expect(afterSecond.filter((t) => t.status === 'backlog')).toHaveLength(0);
  });
});

describe('canDropOnCard', () => {
  it('rejects dropping a card onto another project card', () => {
    expect(canDropOnCard(task({ id: 'm', projectId: 'p1' }), task({ id: 't', projectId: 'p2' }))).toBe(false);
    expect(canDropOnCard(task({ id: 'm', projectId: 'p1' }), task({ id: 't', projectId: 'p1' }))).toBe(true);
  });
});

describe('moveTargetForDrop', () => {
  const board = [
    task({ id: 'head', status: 'ready', position: '100', projectId: 'p1' }),
    task({ id: 'mid', status: 'ready', position: '200', projectId: 'p1' }),
    task({ id: 'tail', status: 'ready', position: '300', projectId: 'p1' }),
    task({ id: 'foreign', status: 'ready', position: '150', projectId: 'p2' }),
    task({ id: 'm', status: 'backlog', position: '900', projectId: 'p1' }),
  ];

  it('derives top anchor from the first same-project card, never both-null on a populated lane', () => {
    const move = moveTargetForDrop(board, { id: 'm', projectId: 'p1' }, { kind: 'lane', status: 'ready' });
    expect(move).toEqual({ status: 'ready', beforeTaskId: null, afterTaskId: 'head', projectId: 'p1' });
  });

  it('returns both-null only for an empty lane section', () => {
    const move = moveTargetForDrop(board, { id: 'm', projectId: 'p1' }, { kind: 'lane', status: 'review' });
    expect(move).toEqual({ status: 'review', beforeTaskId: null, afterTaskId: null, projectId: 'p1' });
  });

  it('brackets a card-after drop with the target and its actual successor', () => {
    const move = moveTargetForDrop(board, { id: 'm', projectId: 'p1' }, { kind: 'card', status: 'ready', targetId: 'head', before: false });
    expect(move).toEqual({ status: 'ready', beforeTaskId: 'head', afterTaskId: 'mid', projectId: 'p1' });
  });

  it('uses a null after-anchor only when the target really is the last card', () => {
    const move = moveTargetForDrop(board, { id: 'm', projectId: 'p1' }, { kind: 'card', status: 'ready', targetId: 'tail', before: false });
    expect(move).toEqual({ status: 'ready', beforeTaskId: 'tail', afterTaskId: null, projectId: 'p1' });
  });

  it('brackets a card-before drop with the predecessor and the target', () => {
    const move = moveTargetForDrop(board, { id: 'm', projectId: 'p1' }, { kind: 'card', status: 'ready', targetId: 'mid', before: true });
    expect(move).toEqual({ status: 'ready', beforeTaskId: 'head', afterTaskId: 'mid', projectId: 'p1' });
  });

  it('excludes the moving card and foreign projects from anchor derivation', () => {
    const boardWithSelf = [
      task({ id: 'm', status: 'ready', position: '50', projectId: 'p1' }),
      task({ id: 'after-self', status: 'ready', position: '60', projectId: 'p1' }),
      task({ id: 'foreign', status: 'ready', position: '55', projectId: 'p2' }),
    ];
    const move = moveTargetForDrop(boardWithSelf, { id: 'm', projectId: 'p1' }, { kind: 'card', status: 'ready', targetId: 'after-self', before: true });
    expect(move).toEqual({ status: 'ready', beforeTaskId: null, afterTaskId: 'after-self', projectId: 'p1' });
  });
});
