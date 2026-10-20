'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LatestRequest, pollResource } from '@/lib/collab/live';
import { collabFetch, ApiError } from '@/lib/collab/api';
import type { AttentionItem, Comment, Criterion, Priority, Run, Task, Visibility } from '@/lib/collab/types';
import { ExecutionBadge } from './execution-badge';
import { ExecutionTab } from './task-execution-tab';
import { WorkpadTab } from './task-workpad-tab';
import { IdeasTab } from './task-ideas-tab';

export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];

export interface TaskDetail extends Task {
  capabilities?: string[];
  criteria?: Criterion[];
  execution?: {
    latestRun: Pick<Run, 'id' | 'state' | 'stage' | 'lastObservedAt'> | null;
    hostReachability: string | null;
    progress: { text: string; percent: number | null } | null;
    attentionCount: number;
  } | null;
}

/** Detail payload loader shared by the task page tabs. */
export function useTaskDetail(taskId: string) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const requests = useRef(new LatestRequest());
  const reload = useCallback(async (parent?: AbortSignal) => {
    const signal = requests.current.begin(parent);
    try {
      const [result, criteria] = await Promise.all([
        collabFetch<TaskDetail>(`/tasks/${taskId}`, { signal }),
        collabFetch<Criterion[]>(`/tasks/${taskId}/criteria`, { signal }),
      ]);
      if (!requests.current.current(signal)) return;
      setDetail({ ...result.data, criteria: criteria.data });
      setError(null);
    } catch (err) {
      if (!requests.current.current(signal)) return;
      const denied = err instanceof ApiError && [401, 403, 404].includes(err.status);
      if (denied) setDetail(null);
      setError(denied
        ? err instanceof ApiError && err.status === 404 ? 'Not found.' : 'This task is no longer available.'
        : 'Task updates are temporarily unavailable.');
    } finally {
      if (requests.current.current(signal)) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setDetail(null);
    setLoading(true);
    const stop = pollResource(reload);
    return () => { stop(); requests.current.dispose(); };
  }, [reload]);

  return { detail, setDetail, error, loading, reload };
}

export function can(detail: TaskDetail | null, capability: string): boolean {
  return detail?.capabilities?.includes(capability) ?? false;
}

export function TaskDetailPage({ taskId }: { taskId: string }) {
  const { detail, setDetail, error, loading, reload } = useTaskDetail(taskId);
  const [tab, setTab] = useState<'overview' | 'execution' | 'workpad' | 'ideas'>('overview');
  const [attention, setAttention] = useState<AttentionItem[]>([]);

  const loadAttention = useCallback(async () => {
    try {
      const result = await collabFetch<AttentionItem[]>(`/attention?taskId=${taskId}`);
      setAttention(result.data);
    } catch {
      setAttention([]);
    }
  }, [taskId]);

  useEffect(() => {
    const stop = pollResource(() => loadAttention());
    return stop;
  }, [loadAttention, detail?.updatedAt]);

  if (loading) {
    return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;
  }
  if (!detail) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <p className="text-sm text-muted-foreground">{error ?? 'Not found.'}</p>
        <Button variant="outline" asChild>
          <Link href="/board">Back to board</Link>
        </Button>
      </div>
    );
  }

  const tabs = [
    { id: 'overview' as const, label: 'Overview' },
    { id: 'execution' as const, label: 'Execution' },
    { id: 'workpad' as const, label: 'Workpad' },
    { id: 'ideas' as const, label: 'Ideas' },
  ];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      {error ? <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">{error}</p> : null}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/board">
            <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Board
          </Link>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void reload()}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{detail.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded border border-border bg-secondary px-1.5 py-0.5">{detail.status}</span>
            <span className="rounded border border-border bg-secondary px-1.5 py-0.5">{detail.priority}</span>
            {detail.blockedReason ? (
              <span className="rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-destructive">
                blocked: {detail.blockedReason}
              </span>
            ) : null}
            <ExecutionBadge
              state={detail.execution?.latestRun?.state ?? null}
              reachability={(detail.execution?.hostReachability as never) ?? null}
              attentionCount={detail.execution?.attentionCount}
            />
            <span>updated {new Date(detail.updatedAt).toLocaleString()}</span>
          </div>
        </div>
      </header>

      {attention.length > 0 ? (
        <div className="rounded-md border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-sm">
          <p className="font-medium">Needs attention ({attention.length})</p>
          <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
            {attention.slice(0, 5).map((item) => (
              <li key={item.id}>
                {item.title}
                {item.createdAt ? ` · ${new Date(item.createdAt).toLocaleString()}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <nav className="flex gap-1 border-b border-border" aria-label="Task sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`rounded-t-md px-3 py-2 text-sm ${
              tab === t.id ? 'border-x border-t border-border bg-card font-medium' : 'text-muted-foreground hover:bg-secondary'
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? <OverviewTab detail={detail} setDetail={setDetail} reload={reload} /> : null}
      {tab === 'execution' ? <ExecutionTab detail={detail} reload={reload} /> : null}
      {tab === 'workpad' ? <WorkpadTab detail={detail} setDetail={setDetail} reload={reload} /> : null}
      {tab === 'ideas' ? <IdeasTab detail={detail} /> : null}
    </div>
  );
}

function OverviewTab({
  detail,
  setDetail,
  reload,
}: {
  detail: TaskDetail;
  setDetail: (t: TaskDetail) => void;
  reload: () => Promise<void>;
}) {
  const canWrite = can(detail, 'task.write');
  const canComment = can(detail, 'comment.write');
  const canInternal = can(detail, 'internal.read');

  const [description, setDescription] = useState(detail.description);
  const [title, setTitle] = useState(detail.title);
  const [priority, setPriority] = useState(detail.priority);
  const [blockedReason, setBlockedReason] = useState(detail.blockedReason ?? '');
  const [editing, setEditing] = useState(false);
  const [editingVersion,setEditingVersion]=useState(detail.version);
  const [assigneeId,setAssigneeId]=useState(detail.assigneeId??'');
  const [assignees,setAssignees]=useState<{id:string;displayName:string}[]>([]);
  const [saving,setSaving]=useState(false);
  useEffect(()=>{
    if(!canWrite){setAssignees([]);setEditing(false);return;}
    const controller=new AbortController();
    void collabFetch<{id:string;displayName:string}[]>(`/projects/${detail.projectId}/assignees`,{signal:controller.signal})
      .then(result=>{if(!controller.signal.aborted)setAssignees(result.data);})
      .catch(err=>{if(!controller.signal.aborted){setAssignees([]);setSaveError(err instanceof ApiError?err.message:'Could not load project members.');}});
    return ()=>controller.abort();
  },[detail.projectId,canWrite]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  async function saveChanges(version=editingVersion) {
    if(saving)return;
    setSaving(true);
    try {
      const result = await collabFetch<TaskDetail>(`/tasks/${detail.id}`, {
        method: 'PATCH',
        body: {
          expectedVersion: version,
          description,
          title: title.trim() || detail.title,
          priority,
          assigneeId:assigneeId||null,
          blockedReason: blockedReason.trim() || null,
        },
      });
      setDetail({ ...detail, ...result.data });
      setEditing(false);
      setSaveError(null);
      setConflict(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        setSaveError('This item changed. Refresh before saving.');
      } else {
        setSaveError(err instanceof Error ? err.message : 'Could not save.');
      }
    } finally {setSaving(false);}
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="flex flex-col gap-4 lg:col-span-2">
        <section aria-label="Description" className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Description</h2>
            {canWrite && !editing ? (
              <Button variant="ghost" size="sm" onClick={() => {setEditingVersion(detail.version);setDescription(detail.description);setTitle(detail.title);setPriority(detail.priority);setBlockedReason(detail.blockedReason??'');setAssigneeId(detail.assigneeId??'');setSaveError(null);setConflict(false);setEditing(true);}}>
                Edit
              </Button>
            ) : null}
          </div>
          {editing ? (
            <div className="mt-2 flex flex-col gap-2">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Task title" />
              <div className="flex gap-2">
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  Priority
                  <select
                    aria-label="Task priority"
                    className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as Priority)}
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <Input
                  className="flex-1"
                  placeholder="Blocked reason (empty = not blocked)"
                  value={blockedReason}
                  onChange={(e) => setBlockedReason(e.target.value)}
                  aria-label="Blocked reason"
                />
              </div>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">Assignee
                <select aria-label="Task assignee" className="h-9 rounded-md border border-border bg-background px-2 text-sm" value={assigneeId} onChange={e=>setAssigneeId(e.target.value)}>
                  <option value="">Unassigned</option>
                  {assignees.map(member=><option key={member.id} value={member.id}>{member.displayName}</option>)}
                </select>
              </label>
              <textarea
                className="min-h-[120px] rounded-md border border-border bg-background px-3 py-2 text-sm"
                aria-label="Task description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              {saveError ? (
                <p role="alert" className="flex items-center gap-2 text-xs text-destructive">
                  {saveError}
                  {conflict ? (
                    <Button size="sm" variant="outline" onClick={() => void reload()}>
                      Refresh
                    </Button>
                  ) : null}
                </p>
              ) : null}
              {conflict?<div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                <p>Current version: {detail.version}. Your draft started at version {editingVersion}.</p>
                <p className="mt-1 whitespace-pre-wrap">Current description: {detail.description||'No description yet.'}</p>
                <Button size="sm" variant="outline" disabled={saving} className="mt-2" onClick={()=>void saveChanges(detail.version)}>Save draft with current version</Button>
              </div>:null}
              <div className="flex gap-2">
                <Button size="sm" disabled={saving} onClick={() => void saveChanges()}>
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(false);
                    setDescription(detail.description);
                    setTitle(detail.title);
                    setPriority(detail.priority);
                    setBlockedReason(detail.blockedReason ?? '');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
              {detail.description || 'No description yet.'}
            </p>
          )}
        </section>

        <CriteriaPanel detail={detail} reload={reload} />
        <CommentsPanel detail={detail} canInternal={canInternal} reload={reload} />
      </div>

      <aside className="flex flex-col gap-4">
        <section aria-label="Details" className="rounded-lg border border-border bg-card p-4 text-sm">
          <h2 className="text-sm font-medium">Details</h2>
          <dl className="mt-2 flex flex-col gap-1.5 text-xs text-muted-foreground">
            <div className="flex justify-between gap-2">
              <dt>Status</dt>
              <dd>{detail.status}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Priority</dt>
              <dd>{detail.priority}</dd>
            </div>
            {detail.assigneeName ? (
              <div className="flex justify-between gap-2">
                <dt>Assignee</dt>
                <dd>{detail.assigneeName}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-2">
              <dt>Version</dt>
              <dd>{detail.version}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Created</dt>
              <dd>{new Date(detail.createdAt).toLocaleString()}</dd>
            </div>
          </dl>
        </section>
      </aside>
    </div>
  );
}

function CriteriaPanel({ detail, reload }: { detail: TaskDetail; reload: () => Promise<void> }) {
  const canWrite = can(detail, 'task.write');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const criteria = detail.criteria ?? [];
  const [criteriaError,setCriteriaError]=useState<string|null>(null);

  async function addCriterion(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await collabFetch(`/tasks/${detail.id}/criteria`, { method: 'POST', body: { text: text.trim() } });
      setText('');
      await reload();
      setCriteriaError(null);
    } catch(err){setCriteriaError(err instanceof ApiError?err.message:'Could not save the criterion.');}
    finally {
      setBusy(false);
    }
  }

  async function setCriterionState(id: string, state: 'open' | 'met' | 'waived') {
    const criterion = criteria.find((c) => c.id === id);
    if (!criterion) return;
    try {
    await collabFetch(`/tasks/${detail.id}/criteria/${id}`, {
      method: 'PATCH',
      body: { expectedVersion: criterion.version, state },
    });
    await reload();
    } catch(err){setCriteriaError(err instanceof ApiError?err.message:'Could not update the criterion.');}
  }

  return (
    <section aria-label="Acceptance criteria" className="rounded-lg border border-border bg-card p-4">
<h2 className="text-sm font-medium">Acceptance criteria</h2>
      {criteriaError?<p role="alert" className="mt-2 text-xs text-destructive">{criteriaError}</p>:null}
      <ul className="mt-2 flex flex-col gap-1.5">
        {criteria.length === 0 ? <li className="text-xs text-muted-foreground">None yet.</li> : null}
        {criteria.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2">
              <span
                className={`rounded px-1.5 py-0.5 text-[11px] ${
                  c.state === 'met'
                    ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : c.state === 'waived'
                      ? 'border border-border bg-secondary text-muted-foreground'
                      : 'border border-border bg-secondary text-muted-foreground'
                }`}
              >
                {c.state}
              </span>
              {c.text}
            </span>
            {canWrite ? (
              <span className="flex gap-1">
                {c.state !== 'met' ? (
                  <button className="rounded px-1 text-xs text-muted-foreground hover:bg-secondary" onClick={() => void setCriterionState(c.id, 'met')}>
                    met
                  </button>
                ) : null}
                {c.state !== 'waived' ? (
                  <button className="rounded px-1 text-xs text-muted-foreground hover:bg-secondary" onClick={() => void setCriterionState(c.id, 'waived')}>
                    waive
                  </button>
                ) : null}
                {c.state !== 'open' ? (
                  <button className="rounded px-1 text-xs text-muted-foreground hover:bg-secondary" onClick={() => void setCriterionState(c.id, 'open')}>
                    reopen
                  </button>
                ) : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {canWrite ? (
        <form onSubmit={addCriterion} className="mt-3 flex gap-2">
          <Input placeholder="Add a criterion…" value={text} onChange={(e) => setText(e.target.value)} />
          <Button size="sm" type="submit" disabled={busy}>
            Add
          </Button>
        </form>
      ) : null}
    </section>
  );
}

function CommentsPanel({
  detail,
  canInternal,
  reload,
}: {
  detail: TaskDetail;
  canInternal: boolean;
  reload: () => Promise<void>;
}) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('client');
  const [busy, setBusy] = useState(false);

  const commentRequests=useRef(new LatestRequest());
  const [commentError,setCommentError]=useState<string|null>(null);
  const loadComments=useCallback(async(parent?:AbortSignal)=>{
    const signal=commentRequests.current.begin(parent);
    try{
      const result=await collabFetch<Comment[]>(`/tasks/${detail.id}/comments`,{signal});
      if(commentRequests.current.current(signal)){setComments(result.data);setCommentError(null);}
    }catch(err){if(commentRequests.current.current(signal)){setComments([]);setCommentError(err instanceof ApiError?err.message:'Could not load discussion.');}}
  },[detail.id]);
  useEffect(()=>{
    const stop=pollResource(loadComments);
    return ()=>{stop();commentRequests.current.dispose();};
  },[loadComments]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await collabFetch(`/tasks/${detail.id}/comments`, {
        method: 'POST',
        body: { body: body.trim(), visibility },
      });
      setBody('');
      await loadComments();
      await reload();
    } catch(err){setCommentError(err instanceof ApiError?err.message:'Could not post the comment.');}
    finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Discussion" className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Discussion</h2>
      {commentError?<p role="alert" className="mt-2 text-xs text-destructive">{commentError}</p>:null}
      <ul className="mt-2 flex flex-col gap-3">
        {(comments ?? []).length === 0 ? <li className="text-xs text-muted-foreground">No comments yet.</li> : null}
        {(comments ?? []).map((comment) => (
          <li key={comment.id} className="rounded-md border border-border bg-background p-2.5 text-sm">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{comment.authorName}</span>
              <span>{new Date(comment.createdAt).toLocaleString()}</span>
              <span
                className={`rounded border px-1 py-0.5 text-[10px] ${
                  comment.visibility === 'internal'
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                    : 'border-border bg-secondary'
                }`}
              >
                {comment.visibility}
              </span>
            </div>
            <p className="mt-1 whitespace-pre-wrap">{comment.body}</p>
          </li>
        ))}
      </ul>
      {can(detail, 'comment.write') ? (
        <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
          <textarea
            className="min-h-[64px] rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder="Write a comment…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex items-center justify-between">
            <select
              aria-label="Comment visibility"
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as Visibility)}
            >
              <option value="client">Client-visible</option>
              {canInternal ? <option value="internal">Internal only</option> : null}
            </select>
            <Button size="sm" type="submit" disabled={busy}>
              Comment
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
