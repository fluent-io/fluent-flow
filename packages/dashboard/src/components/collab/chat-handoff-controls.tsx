'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, collabFetch } from '@/lib/collab/api';
import { LatestRequest, pollResource } from '@/lib/collab/live';
import type { SubmitClaimCommandResult } from '@/lib/collab/types';
import type { TaskDetail } from './task-detail';

type Digest = { goal: string; decisions: string[]; acceptanceCriteria: string[]; openQuestions: string[]; filesTouched: string[] };
type Handoff = {
  commandId: number; status: string; reason: string | null;
  prepared: { digest: Digest; branch: string; headSha: string } | null;
  started: { claimId: number; taskId: string } | null;
};
const failures: Record<string, string> = {
  commit_required: 'Commit the session changes before preparing the build.',
  push_required: 'Push the task branch before preparing the build.',
  task_branch_required: 'Return the session to its task branch before preparing the build.',
  summary_invalid: 'The agent did not produce a complete build summary. Prepare it again.',
  summary_interrupted: 'The build summary was interrupted. Prepare it again.',
};

export function ChatHandoffControls({ detail, claimId, repo, canCreateTask, reload }: {
  detail: TaskDetail; claimId: number; repo: string | null; canCreateTask: boolean; reload: () => Promise<void>;
}) {
  const [commandId, setCommandId] = useState<number | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [separate, setSeparate] = useState(false);
  const [title, setTitle] = useState('');
  const [waiting, setWaiting] = useState(false);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const key = useRef(crypto.randomUUID());
  const confirm = useRef<{ key: string; body: { expectedVersion: number; destinationTitle?: string } } | null>(null);
  const request = useRef(new LatestRequest());

  const load = useCallback(async (parent?: AbortSignal) => {
    if (commandId === null) return;
    const signal = request.current.begin(parent);
    try {
      const result = await collabFetch<Handoff>(`/claim-executions/${claimId}/handoffs/${commandId}`, { signal });
      if (!request.current.current(signal)) return;
      setHandoff(result.data);
      if (!['pending', 'delivered'].includes(result.data.status)) setWaiting(false);
      if (['failed', 'uncertain', 'cancelled'].includes(result.data.status)) {
        setError(failures[result.data.reason ?? ''] ?? 'The build summary could not be prepared. No unattended work was started.');
      } else setError(null);
    } catch (failure) {
      if (!request.current.current(signal)) return;
      if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
        setHandoff(null); setWaiting(false);
        setError('Build handoff is no longer available.');
      } else setError('Build status is temporarily unavailable. Do not repeat an uncertain request.');
    }
  }, [claimId, commandId]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; request.current.dispose(); };
  }, []);
  useEffect(() => {
    if (waiting) return pollResource(load, 1000);
  }, [load, waiting]);

  async function prepare() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await collabFetch<SubmitClaimCommandResult>(`/claim-executions/${claimId}/commands`, {
        method: 'POST', idempotencyKey: key.current, body: { kind: 'handoff', payload: {} },
      });
      if (!alive.current) return;
      setHandoff(null); setCommandId(result.data.commandId); setWaiting(true);
      confirm.current = null;
    } catch (failure) {
      if (alive.current) setError(failure instanceof ApiError && [401,403,404].includes(failure.status)
        ? 'Build handoff is no longer available.' : 'Could not prepare the build. Retry preserves this request.');
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function start() {
    if (inFlight.current || commandId === null || !handoff?.prepared) return;
    if (separate && !title.trim()) return;
    inFlight.current = true; setBusy(true); setError(null);
    const intent = confirm.current ?? { key: crypto.randomUUID(), body: {
      expectedVersion: detail.version, ...(separate ? { destinationTitle: title.trim() } : {}),
    } };
    confirm.current = intent;
    try {
      const result = await collabFetch<{ claimId: number; taskId: string }>(`/claim-executions/${claimId}/handoffs/${commandId}`, {
        method: 'POST', idempotencyKey: intent.key, body: intent.body,
      });
      if (!alive.current) return;
      setHandoff(current => current ? { ...current, started: result.data } : current);
      try { await reload(); }
      catch { if (alive.current) setError('The build started, but task details could not refresh. Reopen the task to see progress.'); }
    } catch (failure) {
      if (!alive.current) return;
      setError(failure instanceof ApiError && failure.code === 'version_conflict'
        ? 'The task changed. Refresh it before confirming the build.'
        : 'Could not confirm the build. Checking its saved status before any retry.');
      await load();
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }

  if (!repo) return <p className="mt-3 text-xs text-muted-foreground">Build handoff is unavailable for a session without a repository.</p>;
  const ready = handoff?.prepared;
  return <section aria-label="Build handoff" className="mt-3 space-y-3">
    {handoff?.started ? <p role="status" className="text-sm">Unattended build queued. <Link className="underline underline-offset-4" href={`/board?projectId=${encodeURIComponent(detail.projectId)}&taskId=${handoff.started.taskId}`}>View task progress</Link>. This chat stays open.</p>
      : <>
        {!ready && <Button variant="outline" size="sm" disabled={busy || waiting} onClick={() => {
          if (handoff && ['failed','uncertain','cancelled'].includes(handoff.status)) key.current = crypto.randomUUID();
          void prepare();
        }}>{waiting ? 'Preparing build summary…' : 'Build this'}</Button>}
        {!ready && <p className="text-xs text-muted-foreground">Commit and push session changes first. Review the summary before starting unattended work.</p>}
        {ready && <div className="max-h-[45vh] space-y-3 overflow-y-auto rounded-md border border-border p-3">
          <h4 className="text-sm font-medium">Review build summary</h4>
          <p className="whitespace-pre-wrap text-sm">{ready.digest.goal}</p>
          {([['Decisions', ready.digest.decisions], ['Acceptance criteria', ready.digest.acceptanceCriteria], ['Open questions', ready.digest.openQuestions], ['Files touched', ready.digest.filesTouched]] as const).map(([label, items]) => items.length > 0 ? <div key={label}><h5 className="text-xs font-medium">{label}</h5><ul className="mt-1 list-disc space-y-1 pl-4 text-sm">{items.map((item,index) => <li key={index}>{item}</li>)}</ul></div> : null)}
          <p className="text-xs text-muted-foreground">The reviewed summary will be added to the task description. The build uses the published design snapshot; it does not inherit chat context.</p>
          {canCreateTask && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={separate} disabled={busy} onChange={event => { setSeparate(event.target.checked); confirm.current = null; }}/>Create a separate task</label>}
          {separate && <label className="block text-sm">Build task title<Input value={title} disabled={busy} maxLength={300} onChange={event => { setTitle(event.target.value); confirm.current = null; }}/></label>}
          <Button size="sm" disabled={busy || (separate && !title.trim())} onClick={() => void start()}>Confirm build</Button>
        </div>}
      </>}
    {error && <p role="alert" className="text-xs text-destructive">{error}{error.startsWith('The task changed.') && <Button variant="ghost" size="sm" onClick={() => { confirm.current = null; void reload().catch(() => { if (alive.current) setError('Task details could not refresh. Reopen the task.'); }); }}>Refresh task</Button>}</p>}
  </section>;
}
