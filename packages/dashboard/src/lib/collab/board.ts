import type { Task, TaskStatus } from './types';

export interface MoveTarget {
  status: TaskStatus;
  beforeTaskId: string | null;
  afterTaskId: string | null;
  projectId?: string;
}

export function canDropOnCard(moving: Pick<Task, 'projectId'>, target: Pick<Task, 'projectId'>): boolean {
  return moving.projectId === target.projectId;
}

export function buildMoveRequest(
  lane: Task[],
  status: TaskStatus,
  opts: { moving: Task; beforeTaskId?: string | null; afterTaskId?: string | null },
): MoveTarget {
  const scoped = lane.filter((t) => t.projectId === opts.moving.projectId);
  const explicitNeighbors = opts.beforeTaskId !== undefined || opts.afterTaskId !== undefined;
  if (!explicitNeighbors) {
    return {
      status,
      beforeTaskId: null,
      afterTaskId: scoped[0]?.id ?? null,
      projectId: opts.moving.projectId,
    };
  }
  return {
    status,
    beforeTaskId: opts.beforeTaskId ?? null,
    afterTaskId: opts.afterTaskId ?? null,
    projectId: opts.moving.projectId,
  };
}

export function applyBoardMove(tasks: Task[], movingId: string, move: MoveTarget): Task[] {
  const movingIndex = tasks.findIndex((t) => t.id === movingId);
  if (movingIndex === -1) return tasks;
  const moving = tasks[movingIndex];
  const projectId = move.projectId ?? moving.projectId;

  const rest = tasks.filter((t) => t.id !== movingId);
  const scoped = rest.filter((t) => t.status === move.status && t.projectId === projectId);

  let insertAt: number;
  if (move.afterTaskId) {
    const afterGlobal = rest.findIndex((t) => t.id === move.afterTaskId && t.projectId === projectId);
    insertAt = afterGlobal === -1 ? globalIndexScopedTop(rest, projectId, move.status) : afterGlobal;
  } else if (move.beforeTaskId) {
    const beforeGlobal = rest.findIndex((t) => t.id === move.beforeTaskId && t.projectId === projectId);
    insertAt = beforeGlobal === -1 ? globalIndexScopedEnd(rest, projectId, move.status) : beforeGlobal + 1;
  } else {
    insertAt = globalIndexScopedTop(rest, projectId, move.status);
  }

  const updated: Task = { ...moving, status: move.status, updatedAt: new Date().toISOString() };
  return [...rest.slice(0, insertAt), updated, ...rest.slice(insertAt)];
}

function globalIndexScopedTop(rest: Task[], projectId: string, status: TaskStatus): number {
  const first = rest.findIndex((t) => t.projectId === projectId && t.status === status);
  return first === -1 ? rest.length : first;
}

function globalIndexScopedEnd(rest: Task[], projectId: string, status: TaskStatus): number {
  let last = -1;
  rest.forEach((t, index) => {
    if (t.projectId === projectId && t.status === status) last = index;
  });
  return last === -1 ? rest.length : last + 1;
}

export function tasksInLaneOrder(tasks: Task[], status: TaskStatus, projectId?: string): Task[] {
  return tasks.filter((t) => t.status === status && (projectId === undefined || t.projectId === projectId));
}

export function moveTargetForDrop(
  tasks: Task[],
  moving: Pick<Task, 'id' | 'projectId'>,
  drop:
    | { kind: 'lane'; status: TaskStatus }
    | { kind: 'card'; status: TaskStatus; targetId: string; before: boolean },
): MoveTarget {
  const scoped = tasks.filter(
    (t) => t.status === drop.status && t.projectId === moving.projectId && t.id !== moving.id,
  );

  if (drop.kind === 'lane') {
    return {
      status: drop.status,
      beforeTaskId: null,
      afterTaskId: scoped[0]?.id ?? null,
      projectId: moving.projectId,
    };
  }

  const targetIndex = scoped.findIndex((t) => t.id === drop.targetId);
  if (targetIndex === -1) {
    return { status: drop.status, beforeTaskId: null, afterTaskId: scoped[0]?.id ?? null, projectId: moving.projectId };
  }

  if (drop.before) {
    return {
      status: drop.status,
      beforeTaskId: scoped[targetIndex - 1]?.id ?? null,
      afterTaskId: drop.targetId,
      projectId: moving.projectId,
    };
  }
  return {
    status: drop.status,
    beforeTaskId: drop.targetId,
    afterTaskId: scoped[targetIndex + 1]?.id ?? null,
    projectId: moving.projectId,
  };
}
