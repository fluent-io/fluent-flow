'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LatestRequest, pollResource } from '@/lib/collab/live';
import { collabFetch, ApiError } from '@/lib/collab/api';
import { capabilitiesFor, useMe } from '@/lib/collab/use-me';
import { TaskSessions } from './task-sessions';
import { StartTaskWork } from './start-task-work';
import type { AttentionItem, Comment, Criterion, Priority, Run, Task, Visibility } from '@/lib/collab/types';
import type { ClaimProgressCard } from '@/lib/collab/claim-progress';
import { ExecutionBadge } from './execution-badge';
import { TaskClaimExecutionTab } from './task-claim-execution-tab';
import { WorkpadTab } from './task-workpad-tab';
import { IdeasTab } from './task-ideas-tab';

import { RetainedWorkNotice } from './retained-work-notice';
export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];

export interface TaskDetail extends Task {
  capabilities?: string[];
  criteria?: Criterion[];
  execution?: {
    latestRun: Pick<Run, 'id' | 'state' | 'stage' | 'lastObservedAt'> | null;
    hostReachability: string | null;
    progress: string | { text: string; percent: number | null } | null;
    attentionCount: number;
  } | null;
}

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

export function TaskDetailPage({ taskId, selectedClaimId = null, onSelectClaim = () => {} }: {
  taskId: string; selectedClaimId?: number | null; onSelectClaim?: (id: number | null) => void;
}) {
  const { detail, setDetail, error, loading, reload } = useTaskDetail(taskId);
  const { me } = useMe();
  if (loading) return <p role="status" className="p-6 text-sm text-muted-foreground">Loading task…</p>;
  if (!detail) return <p role="alert" className="p-6 text-sm">{error ?? 'This task is unavailable.'}</p>;
  const capabilities = (detail.capabilities ?? []).filter(cap => capabilitiesFor(me, detail.projectId).includes(cap));
  const scoped = { ...detail, capabilities };
  const authority = `${taskId}:${me?.principal.id}:${me?.principal.sessionVersion}:${capabilities.join(',')}`;
  const project = me?.workspaces?.flatMap(w=>w.projects).find(p=>p.id===detail.projectId);
  return <TaskDetailContent key={authority} detail={scoped} setDetail={setDetail} error={error} reload={reload} repo={project?.linkedRepoFullName??null} attendedAvailable={project?.executionMode === 'chat'}
    selectedClaimId={selectedClaimId} onSelectClaim={onSelectClaim} />;
}

function Disclosure({ title, children }: {title: string; children: React.ReactNode}) {
  const [open, setOpen] = useState(false);
  return <details className="border-b border-border py-4" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-medium">{title}</summary>
    {open ? <div className="mt-4 min-w-0">{children}</div> : null}
  </details>;
}

function TaskDetailContent({detail, setDetail, error, reload, selectedClaimId, onSelectClaim, repo, attendedAvailable}: {
  repo: string | null; attendedAvailable: boolean;
  detail: TaskDetail; setDetail: (value: TaskDetail) => void; error: string | null; reload: () => Promise<void>;
  selectedClaimId: number | null; onSelectClaim: (id: number | null) => void;
}) {
  const [progress, setProgress] = useState<ClaimProgressCard[] | null>(null);
  const attention = progress === null
    ? detail.claimActivity?.needsInput ? [{ claimId: detail.claimActivity.claimId, claimType: detail.claimActivity.claimType }] : []
    : progress.filter(claim => ['pending', 'claimed'].includes(claim.status) && claim.needsInput);
  const liveWork = progress?.filter(claim => claim.claimType !== 'chat' && ['pending', 'claimed'].includes(claim.status)) ?? [];
  const unread = progress?.filter(claim => ['pending', 'claimed'].includes(claim.status) && claim.unread).length ?? 0;
  if (selectedClaimId !== null) return <TaskClaimExecutionTab detail={detail} reload={reload}
    selectedClaimId={selectedClaimId} onBack={() => onSelectClaim(null)} />;
  return <div className="space-y-6 p-5 sm:p-6">
    {error ? <p role="status" className="text-sm text-muted-foreground">{error}</p> : null}
    <header><h1 className="break-words text-2xl font-semibold tracking-tight">{detail.title}</h1>
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground"><span className="rounded bg-secondary px-2 py-1">{detail.status.replaceAll('_', ' ')}</span><span className="py-1">{detail.priority} priority</span></div>
    </header>
    <OverviewTab detail={detail} setDetail={setDetail} reload={reload} />
    <section aria-label="Latest progress" className="border-t border-border pt-5">
      <h2 className="text-sm font-medium">Latest progress</h2>
      <p className="mt-3 text-sm text-muted-foreground">{detail.blockedReason ? `Blocked: ${detail.blockedReason}` : detail.execution?.progress ? (typeof detail.execution.progress === 'string' ? detail.execution.progress : detail.execution.progress.text) : 'No published progress yet.'}</p>
      {detail.claimActivity ? <button className="mt-3 block text-left text-sm text-muted-foreground hover:text-foreground" onClick={()=>onSelectClaim(detail.claimActivity!.claimId)}>{detail.claimActivity.claimType === 'chat' ? 'Agent session' : detail.claimActivity.claimType} · {detail.claimActivity.status === 'claimed' && detail.claimActivity.claimType === 'chat' ? 'Open' : detail.claimActivity.status}{detail.claimActivity.endReason ? ` · ${detail.claimActivity.endReason.replaceAll('_',' ')}` : ''}</button> : null}
      {detail.execution?.attentionCount ? <p className="mt-2 text-sm">Needs attention · {detail.execution.attentionCount}</p> : null}
      {attention.map(claim => <Button key={claim.claimId} variant="outline" size="sm" className="mt-3 mr-2" onClick={()=>onSelectClaim(claim.claimId)}>{can(detail,'run.steer') ? attention.length === 1 ? 'Needs your input — view session' : `Needs your input — view ${claim.claimType} ${claim.claimId}` : 'Session needs attention'}</Button>)}
      {can(detail,'internal.read') && unread > 0 ? <p className="mt-2 text-xs text-muted-foreground">{unread} active {unread === 1 ? 'session has' : 'sessions have'} unread activity.</p> : null}
      {liveWork.length > 0 ? <ul className="mt-3 space-y-1 text-sm">{liveWork.map(claim => <li key={claim.claimId}><button className="text-muted-foreground hover:text-foreground" onClick={()=>onSelectClaim(claim.claimId)}>{claim.claimType} · attempt {claim.attempt} · {claim.status}</button></li>)}</ul> : null}
      <StartTaskWork detail={detail} repo={repo} reload={reload} onSelectClaim={onSelectClaim}/>
      {can(detail,'internal.read') && <RetainedWorkNotice taskId={detail.id}/>}
    </section>
    <TaskSessions detail={detail} reload={reload} onSelectClaim={onSelectClaim} attendedAvailable={attendedAvailable} repo={repo} onProgress={setProgress} />
    <div>
      <Disclosure title="Workpad & artifacts"><WorkpadTab detail={detail} setDetail={setDetail} reload={reload} /></Disclosure>
      <Disclosure title="Ideas"><IdeasTab detail={detail} /></Disclosure>
      <Disclosure title="Run history"><TaskSessions detail={detail} reload={reload} onSelectClaim={onSelectClaim} history /></Disclosure>
    </div>
    <CommentsPanel detail={detail} canInternal={can(detail, 'internal.read')} reload={reload} />
  </div>;
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4">
        <section aria-label="Description" className="py-1">
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

        <Disclosure title={`Acceptance criteria (${detail.criteria?.length ?? 0})`}><CriteriaPanel detail={detail} reload={reload} /></Disclosure>

      </div>


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
  const commentActive=useRef(true);
  useEffect(()=>{commentActive.current=true;return()=>{commentActive.current=false;};},[]);
  const [commentError,setCommentError]=useState<string|null>(null);
  const loadComments=useCallback(async(parent?:AbortSignal)=>{
    const signal=commentRequests.current.begin(parent);
    try{
      const result=await collabFetch<Comment[]>(`/tasks/${detail.id}/comments`,{signal});
      if(commentRequests.current.current(signal)){setComments(result.data);setCommentError(null);}
    }catch(err){if(commentRequests.current.current(signal)){setComments([]);setCommentError(err instanceof ApiError?err.message:'Could not load discussion.');}}
  },[detail.id,canInternal]);
  useEffect(()=>{
    setBody(''); setVisibility('client'); setComments(null);
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
      if(!commentActive.current)return;
      setBody('');
      await loadComments();
      await reload();
    } catch(err){if(commentActive.current)setCommentError(err instanceof ApiError?err.message:'Could not post the comment.');}
    finally {
      if(commentActive.current)setBusy(false);
    }
  }

  return (
    <section aria-label="Discussion" className="border-t border-border pt-5">
      <h2 className="text-sm font-medium">Discussion</h2>
      <p className="mt-2 text-xs text-muted-foreground">For your collaborators, not agent instructions.</p>
      {commentError?<p role="alert" className="mt-2 text-xs text-destructive">{commentError}</p>:null}
      <ul className="mt-2 flex flex-col gap-3">
        {(comments ?? []).length === 0 ? <li className="text-xs text-muted-foreground">No comments yet.</li> : null}
        {(comments ?? []).filter(comment => canInternal || comment.visibility !== 'internal').map((comment) => (
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
            aria-label="Comment"
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
