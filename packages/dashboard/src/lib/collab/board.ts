import type { Task, TaskStatus } from './types';

export interface MoveTarget {
  status: TaskStatus;
  /** The card the moved card sits after; null means lane top. */
  beforeTaskId: string | null;
  /** The card the moved card sits before; null means lane bottom. */
  afterTaskId: string | null;
  /** The moved task's project; ordering is always scoped to it. */
  projectId?: string;
}

/**
 * Drops onto a specific card are only valid within one project: the board can
 * show several projects at once, and a cross-project drop would send a foreign
 * neighbor ID to the server's project-scoped guard.
 */
export function canDropOnCard(moving: Pick<Task, 'projectId'>, target: Pick<Task, 'projectId'>): boolean {
  return moving.projectId === target.projectId;
}

/** Derive the wire body for a board move from the visible lane contents. */
export function buildMoveRequest(
  lane: Task[],
  status: TaskStatus,
  opts: { moving: Task; beforeTaskId?: string | null; afterTaskId?: string | null },
): MoveTarget {
  const scoped = lane.filter((t) => t.projectId === opts.moving.projectId);
  const explicitNeighbors = opts.beforeTaskId !== undefined || opts.afterTaskId !== undefined;
  if (!explicitNeighbors) {
    // Drop onto the lane itself: top of this project's section of the lane.
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

/**
 * Optimistic local application of a move. `position` is an opaque server rank —
 * it is never compared or interpolated here; the accepted server array order is
 * preserved and the moved card is spliced relative to its same-project
 * neighbors. The server's authoritative placement replaces this on response.
 */
export function applyBoardMove(tasks: Task[], movingId: string, move: MoveTarget): Task[] {
  const movingIndex = tasks.findIndex((t) => t.id === movingId);
  if (movingIndex === -1) return tasks;
  const moving = tasks[movingIndex];
  const projectId = move.projectId ?? moving.projectId;

  const rest = tasks.filter((t) => t.id !== movingId);
  const scoped = rest.filter((t) => t.status === move.status && t.projectId === projectId);

  // Global insertion index: relative to the same-project neighbor cards.
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

/** Render order helper: lanes render in server array order; no client re-ranking. */
export function tasksInLaneOrder(tasks: Task[], status: TaskStatus, projectId?: string): Task[] {
  return tasks.filter((t) => t.status === status && (projectId === undefined || t.projectId === projectId));
}

/**
 * Canonical wire target for a drop. The server ranks between the two anchors,
 * so B sends concrete neighbors whenever the visible lane section has any:
 *  - lane drop / menu top: before=null, after=first card
 *  - menu end:             before=last card, after=null
 *  - card-before:          before=predecessor, after=target
 *  - card-after:           before=target, after=successor
 * Both anchors are null only for a currently empty lane section. Anchors are
 * same-project cards; the moving card is never its own anchor.
 */
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
    // Target not visible in this project's section: fall back to lane top.
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
