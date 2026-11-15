'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LatestRequest, pollResource } from '@/lib/collab/live';
import { collabFetch, ApiError } from '@/lib/collab/api';
import type { Idea, Visibility } from '@/lib/collab/types';
import type { ClaimProgressCard } from '@/lib/collab/claim-progress';
import { can, type TaskDetail } from './task-detail';
import { ExecutionSourceLink, type ExecutionSourceNavigation } from './execution-source-link';

export function IdeasTab({ detail, claimProgress, sourceNavigation }: {
  detail: TaskDetail;
  claimProgress: ClaimProgressCard[] | null;
  sourceNavigation: ExecutionSourceNavigation;
}) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Visibility>(can(detail, 'internal.read') ? 'internal' : 'client');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedClaimId, setSelectedClaimId] = useState<number | null>(null);
  const [followUpDenied, setFollowUpDenied] = useState(false);
  const internalRead = can(detail, 'internal.read');
  const canFollowUp = internalRead && can(detail, 'task.write') && can(detail, 'run.steer') && !followUpDenied;
  const activeChats = useMemo(() => claimProgress?.filter(claim => claim.claimType === 'chat' && claim.status === 'claimed') ?? [], [claimProgress]);
  const selectedChat = activeChats.find(claim => claim.claimId === selectedClaimId);
  const visibleIdeas = useMemo(() => ideas.filter(idea => idea.visibility === 'client' || internalRead), [ideas, internalRead]);

  const ideaRequests=useRef(new LatestRequest());
  const conversionKeys=useRef(new Map<string,string>());
  const loadIdeas=useCallback(async(parent?:AbortSignal)=>{
    const signal=ideaRequests.current.begin(parent);
    try{
      const result=await collabFetch<Idea[]>(`/tasks/${detail.id}/ideas`,{signal});
      if(ideaRequests.current.current(signal)) setIdeas(result.data);
    }catch(err){if(ideaRequests.current.current(signal)){setIdeas([]);setError(err instanceof ApiError?err.message:'Could not load ideas.');}}
  },[detail.id]);
  useEffect(()=>{const stop=pollResource(loadIdeas);return()=>{stop();ideaRequests.current.dispose();};},[loadIdeas]);

  async function addIdea(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await collabFetch(`/tasks/${detail.id}/ideas`, {
        method: 'POST',
        body: { title: title.trim(), body: body.trim(), visibility },
      });
      setTitle('');
      setBody('');
      await loadIdeas();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the idea.');
    } finally {
      setBusy(false);
    }
  }

  async function convert(idea: Idea, kind: 'task' | 'follow_up') {
    const target = kind === 'follow_up' ? selectedChat : null;
    if (kind === 'follow_up' && (!canFollowUp || !target)) {
      setError('Choose an active agent session first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const keyScope = `${idea.id}:${idea.version}:${kind}:${target?.claimId ?? ''}`;
      const key=conversionKeys.current.get(keyScope)??crypto.randomUUID();
      conversionKeys.current.set(keyScope,key);
      await collabFetch(`/ideas/${idea.id}/conversions`, {
        method: 'POST',
        idempotencyKey: key,
        body: {
          taskId: detail.id,
          kind,
          expectedVersion: idea.version,
          ...(target ? { claimId: target.claimId } : { title: idea.title }),
        },
      });
      await loadIdeas();
    } catch (err) {
      if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
        setIdeas([]);
        setTitle('');
        setBody('');
        setSelectedClaimId(null);
        setFollowUpDenied(true);
        setError('This action is no longer available. Reload the task to check your access.');
      } else if (err instanceof ApiError && err.status === 409) {
        setError('This idea or session changed. Reload the task before trying again.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not convert the idea. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Ideas" className="flex max-w-3xl flex-col gap-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-medium">Follow-up ideas</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Ideas stay attached to this work. Converting to a task creates a backlog item only — it never starts execution by itself.
        </p>
        {canFollowUp ? <div className="mt-4 space-y-1.5">
          <label htmlFor={`idea-session-${detail.id}`} className="block text-xs font-medium">Follow-up session</label>
          <select id={`idea-session-${detail.id}`} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={busy || claimProgress === null} value={selectedClaimId ?? ''}
            onChange={event => setSelectedClaimId(event.target.value === '' ? null : Number(event.target.value))}>
            <option value="">Select an active agent session</option>
            {selectedClaimId !== null && !selectedChat ? <option value={selectedClaimId} disabled>Selected session is no longer active</option> : null}
            {activeChats.map(claim => <option key={claim.claimId} value={claim.claimId}>Session {claim.claimId}{claim.profile ? ` · ${claim.profile}` : ''}</option>)}
          </select>
          <p className="text-xs text-muted-foreground">{claimProgress === null ? 'Loading sessions…' : activeChats.length === 0 ? 'Open an agent session above before sending a follow-up.' : 'Choose where to send an idea. This adds a prompt to that session; it does not start a build.'}</p>
        </div> : null}
        <ul className="mt-3 flex flex-col gap-2">
          {visibleIdeas.length === 0 ? <li className="text-xs text-muted-foreground">No ideas recorded.</li> : null}
          {visibleIdeas.map((idea) => (
            <li key={idea.id} className="rounded-md border border-border bg-background p-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{idea.title}</span>
                <span className="text-[11px] text-muted-foreground">
                  {idea.status} · {idea.visibility} · {idea.provenance}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{idea.body}</p>
              <ExecutionSourceLink taskId={detail.id} source={idea} internalRead={internalRead} navigation={sourceNavigation} label="View reporting session" />
              {idea.status==='converted'&&idea.conversionTargetTaskId?<a className="mt-1 block text-xs underline" href={`/tasks/${idea.conversionTargetTaskId}`}>Open converted task</a>:null}
              {internalRead && idea.status === 'converted' && (typeof idea.conversionClaimId === 'number' || idea.conversionCommandId || idea.conversionSessionId) ? <div className="mt-2 text-xs">
                <p className="text-muted-foreground">Follow-up requested.</p>
                <ExecutionSourceLink taskId={detail.id} source={{ claimId: idea.conversionClaimId, commandId: idea.conversionCommandId, sessionId: idea.conversionSessionId }}
                  internalRead={internalRead} navigation={sourceNavigation} label="Open follow-up session" />
              </div> : null}
              {idea.status === 'inbox' && can(detail, 'task.write') ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void convert(idea, 'task')}>
                    Convert to task
                  </Button>
                  {canFollowUp ? <Button size="sm" variant="outline" disabled={busy || !selectedChat} onClick={() => void convert(idea, 'follow_up')}>Send follow-up</Button> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {error ? (
          <p role="alert" className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      {can(detail, 'task.write') ? (
        <form onSubmit={addIdea} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          <Input placeholder="Idea title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea
            className="min-h-[64px] rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder="What could be improved or added next?"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex items-center justify-between">
            <select
              aria-label="Idea visibility"
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as Visibility)}
            >
              {can(detail,'internal.read')?<option value="internal">Internal</option>:null}
              <option value="client">Client-visible</option>
            </select>
            <Button size="sm" type="submit" disabled={busy}>
              Save idea
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
