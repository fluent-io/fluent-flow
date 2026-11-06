'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LatestRequest, pollResource } from '@/lib/collab/live';
import { collabFetch, ApiError } from '@/lib/collab/api';
import type { Idea, Visibility } from '@/lib/collab/types';
import { can, type TaskDetail } from './task-detail';

export function IdeasTab({ detail }: { detail: TaskDetail }) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Visibility>(can(detail, 'internal.read') ? 'internal' : 'client');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function convert(idea: Idea) {
    setBusy(true);
    setError(null);
    try {
      const keyScope=`${idea.id}:${idea.version}:task`;
      const key=conversionKeys.current.get(keyScope)??crypto.randomUUID();
      conversionKeys.current.set(keyScope,key);
      await collabFetch(`/ideas/${idea.id}/conversions`, {
        method: 'POST',
        idempotencyKey: key,
        body: {
          taskId: detail.id,
          kind: 'task',
          expectedVersion: idea.version,
          title: idea.title,
        },
      });
      await loadIdeas();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('This idea was already converted.');
      } else {
        setError(err instanceof Error ? err.message : 'Conversion failed.');
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
        <ul className="mt-3 flex flex-col gap-2">
          {ideas.length === 0 ? <li className="text-xs text-muted-foreground">No ideas recorded.</li> : null}
          {ideas.map((idea) => (
            <li key={idea.id} className="rounded-md border border-border bg-background p-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{idea.title}</span>
                <span className="text-[11px] text-muted-foreground">
                  {idea.status} · {idea.visibility} · {idea.provenance}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{idea.body}</p>
              {idea.status==='converted'&&idea.conversionTargetTaskId?<a className="mt-1 block text-xs underline" href={`/tasks/${idea.conversionTargetTaskId}`}>Open converted task</a>:null}
              {idea.status === 'inbox' ? (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void convert(idea)}>
                    Convert to task
                  </Button>
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
