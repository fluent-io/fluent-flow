'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, collabFetch } from '@/lib/collab/api';
import { LatestRequest, pollResource } from '@/lib/collab/live';
import type { TaskDetail } from './task-detail';

export type SummarySource = { kind: 'claim'; claimId: number } | { kind: 'execution'; runId: string; sessionId: string };
type SummaryIdentity = { kind: 'claim'; claimId: number } | { kind: 'legacy' | 'archive'; runId: string; sessionId: string; archiveId?: string };
type Summary = {
  id: string; body: string; visibility: 'internal' | 'client'; claimId: number | null; runId: string | null; sessionId: string | null;
  model: string | null; profileId: string | null; source: SummaryIdentity | null; sourceCursor: string | null;
  sourceEntryCount: number | null; sourceTruncated: boolean | null; provenance: 'human' | 'agent' | 'runner'; createdAt: string;
};
type SummaryList = { summaries: Summary[]; generation: { enabled: boolean; configured: boolean; online: boolean; available: boolean; canGenerate: boolean } | null };
type Props = { detail: Pick<TaskDetail, 'id' | 'projectId' | 'version' | 'capabilities'>; source?: SummarySource; onOpenSource?: (source: SummaryIdentity) => void };

export function TaskSummaries(props: Props) {
  if (!props.detail.capabilities?.includes('task.read')) return null;
  return <SummaryPanel key={`${props.detail.id}:${props.detail.capabilities?.join(',')}`} {...props} />;
}

function SummaryPanel({ detail, source, onOpenSource }: Props) {
  const internal = detail.capabilities?.includes('internal.read') ?? false;
  const canStart = internal && detail.capabilities?.includes('run.start') && detail.capabilities.includes('run.steer');
  const [data, setData] = useState<SummaryList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const deniedRef = useRef(false);
  const requests = useRef(new LatestRequest());
  const command = useRef<AbortController | null>(null);
  const stopPolling = useRef<(() => void) | null>(null);
  const intent = useRef<{ key: string; expectedVersion: number; source: SummarySource } | null>(null);
  const sourceKey = source?.kind === 'claim' ? `claim:${source.claimId}` : source ? `execution:${source.runId}:${source.sessionId}` : '';
  const currentSource = useRef(sourceKey);
  currentSource.current = sourceKey;

  const clearPrivate = useCallback(() => {
    deniedRef.current = true;
    setDenied(true);
    requests.current.dispose();
    command.current?.abort();
    stopPolling.current?.();
    setData(null);
    setError(null);
    setNotice(null);
    intent.current = null;
  }, []);
  const load = useCallback(async (parent?: AbortSignal) => {
    if (deniedRef.current) return;
    const signal = requests.current.begin(parent);
    try {
      const result = await collabFetch<SummaryList>(`/tasks/${detail.id}/summaries`, { signal });
      if (!requests.current.current(signal)) return;
      setData(result.data);
      setError(null);
    } catch (err) {
      if (!requests.current.current(signal)) return;
      if (err instanceof ApiError && [401, 403, 404].includes(err.status)) clearPrivate();
      else setError('Summaries are temporarily unavailable.');
    }
  }, [detail.id, clearPrivate]);
  useEffect(() => {
    stopPolling.current = pollResource(load);
    return () => { stopPolling.current?.(); requests.current.dispose(); command.current?.abort(); };
  }, [load]);
  useEffect(() => { intent.current = null; setNotice(null); }, [sourceKey, detail.version]);

  async function generate() {
    if (busy || !source || !canStart || !data?.generation?.canGenerate || deniedRef.current) return;
    const controller = new AbortController();
    command.current = controller;
    const selectedSource = sourceKey;
    intent.current ??= { key: crypto.randomUUID(), expectedVersion: detail.version, source };
    const selected = intent.current;
    setBusy(true);
    setError(null);
    try {
      await collabFetch(`/tasks/${detail.id}/summaries`, { method: 'POST', signal: controller.signal, idempotencyKey: selected.key,
        body: { expectedVersion: selected.expectedVersion, source: selected.source } });
      if (controller.signal.aborted) return;
      intent.current = null;
      if (currentSource.current === selectedSource) setNotice('Summary requested. It will appear here after publication.');
      await load();
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof ApiError && [401, 403, 404].includes(err.status)) clearPrivate();
      else setError(err instanceof ApiError && err.status === 409
        ? 'This task or summary request changed. Refresh the task before trying again.'
        : 'Could not request a summary. Retrying preserves this request.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  if (denied) return <section aria-label="Summaries"><p role="status" className="text-sm text-muted-foreground">Summary access is no longer available.</p></section>;
  const visible = data?.summaries.filter(summary => internal || summary.visibility === 'client') ?? [];
  if (!source && !error && !notice && visible.length === 0) return null;
  const generation = internal ? data?.generation : null;
  return <section aria-label="Summaries" className="border-t border-border pt-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-medium">Summaries</h2>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={() => void load()}>Refresh summaries</Button>
        {canStart && source && generation?.canGenerate ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void generate()}>{busy ? 'Requesting summary…' : 'Generate summary'}</Button> : null}
      </div>
    </div>
    {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
    {notice ? <p role="status" className="mt-3 text-sm text-muted-foreground">{notice}</p> : null}
    {!data ? <p role="status" className="mt-3 text-sm text-muted-foreground">Loading summaries…</p> : null}
    {canStart && generation && !generation.enabled ? <p className="mt-3 text-xs text-muted-foreground">Summary generation is disabled for this project.</p> : null}
    {canStart && generation?.enabled && !generation.configured ? <p className="mt-3 text-xs text-muted-foreground">Summary generation is not configured.</p> : null}
    {canStart && generation?.canGenerate && !source ? <p className="mt-3 text-xs text-muted-foreground">Open an execution session to select the source for a generated summary.</p> : null}
    {canStart && source && generation?.canGenerate && !generation.online ? <p className="mt-3 text-xs text-muted-foreground">The configured agent is offline. A request will wait for it to reconnect.</p> : null}
    {data && visible.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No published summaries yet.</p> : null}
    <div className="mt-3 space-y-3">{visible.map((summary, index) => <article key={summary.id} className="rounded-md border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{summary.provenance === 'agent' ? 'Agent summary' : summary.provenance === 'human' ? 'Human summary' : 'Runner summary'}{summary.profileId ? ` · ${summary.profileId}` : ''}{summary.model ? ` · ${summary.model}` : ''}</p>
      {index === 0 ? <p className="mt-2 whitespace-pre-wrap break-words text-sm">{summary.body}</p> : <details className="mt-2"><summary className="cursor-pointer text-sm">Older summary · {new Date(summary.createdAt).toLocaleString()}</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm">{summary.body}</p></details>}
      <p className="mt-2 text-xs text-muted-foreground">Summary, not verification evidence.{summary.sourceCursor ? ` Source event ${summary.sourceCursor}.` : ''}{summary.sourceTruncated ? ' Source text was truncated.' : ''}</p>
      {summary.source && onOpenSource ? <Button variant="ghost" size="sm" className="mt-2" onClick={() => onOpenSource(summary.source!)}>View source session</Button> : null}
    </article>)}</div>
  </section>;
}
