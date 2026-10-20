'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, RefreshCw, Search, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LatestRequest, pollResource } from '@/lib/collab/live';
import { collabFetch, collabFetchAll, ApiError } from '@/lib/collab/api';
import { applyBoardMove, canDropOnCard, moveTargetForDrop } from '@/lib/collab/board';
import { capabilitiesFor, useMe } from '@/lib/collab/use-me';
import type { HostReachability, Project, RunState, Task, TaskStatus } from '@/lib/collab/types';
import { ExecutionBadge } from './execution-badge';
import { CreateTaskDialog } from './create-task-dialog';
import { cn } from '@/lib/utils';

const LANES: { status: TaskStatus; label: string }[] = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'ready', label: 'Ready' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'review', label: 'Review' },
];

interface ExecutionProjection {
  latestRun: { id: string; state: RunState } | null;
  hostReachability: HostReachability | null;
  progress: { text: string; percent: number | null } | null;
  attentionCount: number;
}

type BoardTask = Task & { execution?: ExecutionProjection | null };

const PRIORITY_CLASS: Record<string, string> = {
  urgent: 'border-destructive/40 bg-destructive/10 text-destructive',
  high: 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400',
  normal: 'border-border bg-secondary text-muted-foreground',
  low: 'border-border bg-secondary text-muted-foreground',
};

export function BoardView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { me, error: meError, reload: reloadMe } = useMe();

  const workspaceId = searchParams.get('workspaceId') ?? '';
  const projectId = searchParams.get('projectId') ?? '';
  const q = searchParams.get('q') ?? '';

  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [conflict, setConflict] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createIn, setCreateIn] = useState<{ status: TaskStatus } | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const boardVersions = useRef<Map<string, number>>(new Map());

  const setFilter = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      router.replace(`/board?${next.toString()}`);
    },
    [router, searchParams],
  );

  const projects: Project[] = useMemo(() => {
    if (!me) return [];
    const workspaces = workspaceId ? me.workspaces.filter((w) => w.id === workspaceId) : me.workspaces;
    const all = workspaces.flatMap((w) => w.projects);
    return projectId ? all.filter((p) => p.id === projectId) : all;
  }, [me, workspaceId, projectId]);

  const boardVersionsFromMe = useCallback((currentMe: typeof me) => {
    if (!currentMe) return;
    for (const w of currentMe.workspaces) {
      for (const p of w.projects) {
        boardVersions.current.set(p.id, p.boardVersion);
      }
    }
  }, []);

  const requests = useRef(new LatestRequest());
  const refresh = useCallback(async (parent?: AbortSignal) => {
    if(movesInFlight.current.size>0) return;
    const signal = requests.current.begin(parent);
    // A version-conflict notice must stay visible while the board reloads; only
    // a completed move or leaving the page clears it.
    try {
      const params = new URLSearchParams();
      if (workspaceId) params.set('workspaceId', workspaceId);
      if (projectId) params.set('projectId', projectId);
      if (q) params.set('q', q);
      const query = params.toString();
      const result = await collabFetchAll<BoardTask>(`/tasks${query ? `?${query}` : ''}`, { signal });
      if (!requests.current.current(signal)) return;
      setTasks(result.data);
      setTruncated(result.truncated);
      setLoadError(null);
    } catch (err) {
      if (!requests.current.current(signal)) return;
      setTasks([]);
      setLoadError(err instanceof ApiError ? err.message : 'Could not load the board.');
    } finally {
      if (requests.current.current(signal)) setLoading(false);
    }
    // Project board versions live on /me; reload them with the tasks so moves
    // never carry a stale expectedBoardVersion after another writer moved on.
    if (requests.current.current(signal)) await reloadMe();
  }, [workspaceId, projectId, q, reloadMe]);

  useEffect(() => {
    setTasks([]);
    setLoading(true);
    const stop = pollResource(refresh);
    return () => { stop(); requests.current.dispose(); };
  }, [refresh]);

  useEffect(() => {
    boardVersionsFromMe(me);
  }, [me, boardVersionsFromMe]);

  // One in-flight move per project; responses are applied only for the latest
  // request per task so out-of-order completions cannot regress the board.
  const movesInFlight = useRef<Set<string>>(new Set());
  const moveSeq = useRef<Map<string, number>>(new Map());

  type DropDescriptor =
    | { kind: 'lane'; status: TaskStatus }
    | { kind: 'card'; status: TaskStatus; targetId: string; before: boolean };

  async function moveTask(task: BoardTask, drop: DropDescriptor) {
    if (movesInFlight.current.has(task.projectId)) return;

    const move = moveTargetForDrop(tasks, task, drop);

    const previousIndex = tasks.findIndex((t) => t.id === task.id);
    const previousTask = tasks[previousIndex];
    const seq = (moveSeq.current.get(task.id) ?? 0) + 1;
    moveSeq.current.set(task.id, seq);

    requests.current.dispose();
    const optimistic = applyBoardMove(tasks, task.id, move);
    setTasks(optimistic);
    movesInFlight.current.add(task.projectId);

    const expectedBoardVersion = boardVersions.current.get(task.projectId) ?? 0;
    try {
      const result = await collabFetch<{ task: BoardTask; boardVersion: number }>(`/tasks/${task.id}/moves`, {
        method: 'POST',
        body: {
          expectedVersion: task.version,
          expectedBoardVersion,
          status: move.status,
          beforeTaskId: move.beforeTaskId,
          afterTaskId: move.afterTaskId,
        },
      });
      if (moveSeq.current.get(task.id) !== seq) return; // a newer move superseded this one
      setConflict(false);
      boardVersions.current.set(task.projectId, result.data.boardVersion);
      setTasks((current) => current.map((t) => (t.id === task.id ? { ...t, ...result.data.task } : t)));
    } catch (err) {
      if (moveSeq.current.get(task.id) !== seq) return;
      // Roll back only the moved card; other projects' accepted moves stay put.
      setTasks((current) => {
        const without = current.filter((t) => t.id !== task.id);
        const restored = previousTask ? [...without.slice(0, previousIndex), previousTask, ...without.slice(previousIndex)] : without;
        return restored;
      });
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        void refresh();
        return;
      }
      setLoadError(err instanceof Error ? err.message : 'Move failed.');
    } finally {
      movesInFlight.current.delete(task.projectId);
    }
  }

  function onDropLane(status: TaskStatus, event: React.DragEvent) {
    event.preventDefault();
    const id = event.dataTransfer.getData('text/fluent-flow-task');
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task || task.status === status) return;
    void moveTask(task, { kind: 'lane', status });
  }

  function onDropOnCard(target: BoardTask, beforeInsteadOfAfter: boolean, event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData('text/fluent-flow-task');
    if (!id || id === target.id) return;
    const moving = tasks.find((t) => t.id === id);
    if (!moving) return;
    if (!canDropOnCard(moving, target)) {
      setLoadError('Tasks can only be ordered within their own project.');
      return;
    }
    void moveTask(moving, { kind: 'card', status: target.status, targetId: target.id, before: beforeInsteadOfAfter });
  }

  const visibleLanes = LANES;
  const doneTasks = tasks.filter((t) => t.status === 'done');
  const cancelledTasks = tasks.filter((t) => t.status === 'cancelled' && showCancelled);

  if (meError) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <AlertTriangle className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{meError}</p>
        <Button variant="outline" onClick={() => void reloadMe()}>
          Try again
        </Button>
      </div>
    );
  }

  const canWriteAnywhere = projects.some((p) => capabilitiesFor(me, p.id).includes('task.write'));

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">Board</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="w-56 pl-8"
              placeholder="Search tasks…"
              defaultValue={q}
              onBlur={(e) => setFilter({ q: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setFilter({ q: (e.target as HTMLInputElement).value });
              }}
            />
          </div>
          <select
            aria-label="Client workspace"
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={workspaceId}
            onChange={(e) => setFilter({ workspaceId: e.target.value, projectId: '' })}
          >
            <option value="">All clients</option>
            {me?.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Project"
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={projectId}
            onChange={(e) => setFilter({ projectId: e.target.value })}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh
          </Button>
          {canWriteAnywhere ? (
            <Button size="sm" onClick={() => setCreateIn({ status: 'backlog' })}>
              <Plus className="mr-1 h-3.5 w-3.5" /> New task
            </Button>
          ) : null}
        </div>
      </div>

      {truncated ? (
        <div role="status" className="rounded-md border border-border bg-secondary px-3 py-2 text-xs text-muted-foreground">
          Showing the first {tasks.length} matching tasks. Narrow the filters to see more.
        </div>
      ) : null}
      {conflict ? (
        <div role="alert" className="flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span>This item changed. Refresh before saving.</span>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            Refresh board
          </Button>
        </div>
      ) : null}
      {loadError ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          {loadError}
        </div>
      ) : null}

      <div className="grid flex-1 grid-cols-1 gap-3 overflow-auto md:grid-cols-2 xl:grid-cols-4">
        {visibleLanes.map((lane) => {
          const laneTasks = tasks.filter((t) => t.status === lane.status);
          return (
            <section
              key={lane.status}
              aria-label={lane.label}
              className="flex min-h-[200px] flex-col gap-2 rounded-lg border border-border bg-card/40 p-2"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDropLane(lane.status, e)}
            >
              <div className="flex items-center justify-between px-1">
                <h2 className="text-sm font-medium text-muted-foreground">{lane.label}</h2>
                <span className="text-xs text-muted-foreground">{laneTasks.length}</span>
              </div>
              {laneTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  projectName={projects.find((p) => p.id === task.projectId)?.name ?? ''}
                  canWrite={capabilitiesFor(me, task.projectId).includes('task.write')}
                  tailExcept={(status, excludeId) => tailOf(tasks, status, task.projectId, excludeId)}
                  onDropCard={onDropOnCard}
                  onMove={(target) => void moveTask(task, target)}
                />
              ))}
              {canWriteAnywhere ? (
                <button
                  className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
                  onClick={() => setCreateIn({ status: lane.status })}
                >
                  <Plus className="h-3 w-3" /> Add task
                </button>
              ) : null}
            </section>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">Done ({doneTasks.length})</summary>
          <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3 xl:grid-cols-5">
            {doneTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                projectName={projects.find((p) => p.id === task.projectId)?.name ?? ''}
                canWrite={capabilitiesFor(me, task.projectId).includes('task.write')}
                tailExcept={(status, excludeId) => tailOf(tasks, status, task.projectId, excludeId)}
                onDropCard={onDropOnCard}
                onMove={(target) => void moveTask(task, target)}
                compact
              />
            ))}
          </div>
        </details>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
          Show cancelled ({tasks.filter((t) => t.status === 'cancelled').length})
        </label>
        {cancelledTasks.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3 xl:grid-cols-5">
            {cancelledTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                projectName={projects.find((p) => p.id === task.projectId)?.name ?? ''}
                canWrite={capabilitiesFor(me, task.projectId).includes('task.write')}
                tailExcept={(status, excludeId) => tailOf(tasks, status, task.projectId, excludeId)}
                onDropCard={onDropOnCard}
                onMove={(target) => void moveTask(task, target)}
                compact
              />
            ))}
          </div>
        ) : null}
      </div>

      {createIn ? (
        <CreateTaskDialog
          projects={projects}
          me={me}
          defaultStatus={createIn.status}
          onClose={() => setCreateIn(null)}
          onCreated={(task) => {
            setCreateIn(null);
            setTasks((current) => [...current, task as BoardTask]);
            void reloadMe();
          }}
        />
      ) : null}
      {loading ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
    </div>
  );
}

/** Last same-project card in a lane, per server array order; excludes the moving card. */
function tailOf(tasks: BoardTask[], status: TaskStatus, projectId: string, excludeId: string): string | null {
  const scoped = tasks.filter((t) => t.status === status && t.projectId === projectId && t.id !== excludeId);
  return scoped.at(-1)?.id ?? null;
}

function TaskCard({
  task,
  projectName,
  canWrite,
  tailExcept,
  onDropCard,
  onMove,
  compact,
}: {
  task: BoardTask;
  projectName: string;
  canWrite: boolean;
  tailExcept: (status: TaskStatus, excludeId: string) => string | null;
  onDropCard: (target: BoardTask, before: boolean, event: React.DragEvent) => void;
  onMove: (drop: { kind: 'lane'; status: TaskStatus } | { kind: 'card'; status: TaskStatus; targetId: string; before: boolean }) => void;
  compact?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <article
      draggable={canWrite}
      onDragStart={(e) => {
        if (canWrite) e.dataTransfer.setData('text/fluent-flow-task', task.id);
      }}
      onDragOver={(e) => {
        if (canWrite) e.preventDefault();
      }}
      onDrop={(e) => {
        if (canWrite) onDropCard(task, false, e);
      }}
      className={cn(
        'group rounded-md border border-border bg-card p-2.5 shadow-sm transition-colors hover:border-primary/40',
        compact && 'opacity-80',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Link href={`/tasks/${task.id}`} className="text-sm font-medium hover:underline">
          {task.title}
        </Link>
        {canWrite ? (
          <button
            aria-label={`Move task ${task.title}`}
            className="rounded px-1 text-xs text-muted-foreground opacity-0 hover:bg-secondary group-hover:opacity-100 focus:opacity-100"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋮
          </button>
        ) : null}
      </div>
      {task.assigneeName ? (
        <div className="mt-1 text-[11px] text-muted-foreground">assignee: {task.assigneeName}</div>
      ) : null}
      {task.execution?.progress ? (
        <div className="mt-1 text-[11px] text-muted-foreground">{task.execution.progress.text}</div>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="rounded border border-border bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {projectName}
        </span>
        <span className={cn('rounded border px-1.5 py-0.5 text-[11px]', PRIORITY_CLASS[task.priority])}>
          {task.priority}
        </span>
        {task.blockedReason ? (
          <span className="rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">
            blocked
          </span>
        ) : null}
      </div>
      <div className="mt-1.5">
        <ExecutionBadge
          state={task.execution?.latestRun?.state ?? null}
          reachability={task.execution?.hostReachability ?? null}
          attentionCount={task.execution?.attentionCount}
        />
      </div>
      {menuOpen ? (
        <div className="mt-2 rounded-md border border-border bg-background p-1.5 text-xs">
          {LANES.map((lane) => {
            const tailId = tailExcept(lane.status, task.id);
            return (
              <div key={lane.status} className="flex items-center justify-between gap-1 py-0.5">
                <span className="text-muted-foreground">{lane.label}</span>
                <span className="flex gap-1">
                  <button
                    className="rounded px-1.5 py-0.5 hover:bg-secondary"
                    onClick={() => {
                      setMenuOpen(false);
                      onMove({ kind: 'lane', status: lane.status });
                    }}
                  >
                    top
                  </button>
                  <button
                    className="rounded px-1.5 py-0.5 hover:bg-secondary disabled:opacity-40"
                    disabled={!tailId}
                    onClick={() => {
                      setMenuOpen(false);
                      if (tailId) onMove({ kind: 'card', status: lane.status, targetId: tailId, before: false });
                    }}
                  >
                    end
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}
