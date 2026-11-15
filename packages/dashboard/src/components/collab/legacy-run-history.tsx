'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, collabFetch } from '@/lib/collab/api';
import { LatestRequest } from '@/lib/collab/live';
import type { ExecutionHistoryEntry, ExecutionHistorySession } from '@fluent-flow/db';
import type { HistoricalTimelineEntry } from '@/lib/collab/types';

function useHistoricalPage<T>(path: string) {
  const [rows, setRows] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const requests = useRef(new LatestRequest());
  const load = useCallback(async (after: string | null = null) => {
    const signal = requests.current.begin();
    setLoading(true);
    try {
      const result = await collabFetch<T[]>(`${path}${after ? `${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(after)}` : ''}`, { signal });
      if (!requests.current.current(signal)) return;
      if (!Array.isArray(result.data)) throw new ApiError(502, 'unexpected_response', 'Execution history is unavailable.');
      setRows(previous => after ? [...previous, ...result.data] : result.data);
      setCursor(result.nextCursor);
      setError(null);
    } catch (err) {
      if (!requests.current.current(signal)) return;
      const inaccessible = err instanceof ApiError && [401, 403, 404].includes(err.status);
      if (inaccessible) { setRows([]); setCursor(null); setDenied(true); }
      setError(inaccessible ? 'Execution history is no longer available.' : 'History could not be loaded. Try again.');
    } finally {
      if (requests.current.current(signal)) setLoading(false);
    }
  }, [path]);
  useEffect(() => { void load(); return () => requests.current.dispose(); }, [load]);
  return { rows, cursor, loading, error, denied, load };
}

export function LegacyRunHistory(props: { taskId: string; internalRead: boolean; onSelectRun: (runId: string) => void }) {
  return <HistoricalRunList key={`${props.taskId}:${props.internalRead}`} {...props} />;
}

function HistoricalRunList({ taskId, internalRead, onSelectRun }: { taskId: string; internalRead: boolean; onSelectRun: (runId: string) => void }) {
  const page = useHistoricalPage<ExecutionHistoryEntry>(`/tasks/${taskId}/execution-history?limit=100`);
  return <section aria-label="Historical executions" className="mt-5 space-y-3">
    <h3 className="text-sm font-medium">Historical executions</h3>
    {page.loading && page.rows.length === 0 ? <p role="status" className="text-sm text-muted-foreground">Loading history…</p> : null}
    {page.error ? <p role="alert" className="text-sm text-destructive">{page.error}</p> : null}
    {!page.loading && !page.error && page.rows.length === 0 ? <p className="text-sm text-muted-foreground">No historical executions.</p> : null}
    <ul className="space-y-2">{page.rows.map(run => <li key={run.runId} className="rounded-md border border-border p-3 text-sm">
      <p className="text-xs text-muted-foreground">{run.source.kind === 'archive' ? 'Archived' : 'Historical'} · {run.stage.replaceAll('_', ' ')} · {run.state.replaceAll('_', ' ')}</p>
      {internalRead ? <button className="mt-2 text-left hover:underline" aria-label={`View historical execution from ${run.createdAt}`} onClick={() => onSelectRun(run.runId)}>View historical execution</button> : null}
      <p className="mt-1 text-xs text-muted-foreground">{new Date(run.createdAt).toLocaleString()}</p>
    </li>)}</ul>
    {page.cursor && !page.denied ? <Button size="sm" variant="outline" disabled={page.loading} onClick={() => void page.load(page.cursor)}>Load older executions</Button> : null}
    {page.error && !page.denied ? <Button size="sm" variant="outline" disabled={page.loading} onClick={() => void page.load(page.cursor)}>Try again</Button> : null}
  </section>;
}

interface ReaderProps {
  taskId: string;
  runId: string;
  sessionId: string | null;
  internalRead: boolean;
  onBack: () => void;
  onSelectSession: (sessionId: string | null) => void;
}

export function LegacyExecutionReader(props: ReaderProps) {
  if (!props.internalRead) return <div className="space-y-4 p-5"><Button size="sm" variant="ghost" onClick={props.onBack}>Back to task</Button><p role="alert">Execution history is available to project operators.</p></div>;
  return <HistoricalExecution key={`${props.taskId}:${props.runId}:${props.sessionId ?? ''}`} {...props} />;
}

function HistoricalExecution({ taskId, runId, sessionId, onBack, onSelectSession }: ReaderProps) {
  const root = `/tasks/${taskId}/execution-history/${runId}`;
  const [entry, setEntry] = useState<ExecutionHistoryEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requests = useRef(new LatestRequest());
  const load = useCallback(async () => {
    const signal = requests.current.begin();
    try {
      const result = await collabFetch<ExecutionHistoryEntry>(root, { signal });
      if (!requests.current.current(signal)) return;
      setEntry(result.data);
      setError(null);
    } catch (err) {
      if (!requests.current.current(signal)) return;
      setEntry(null);
      setError(err instanceof ApiError && [401, 403, 404].includes(err.status) ? 'Execution history is no longer available.' : 'History could not be loaded.');
    }
  }, [root]);
  useEffect(() => { void load(); return () => requests.current.dispose(); }, [load]);
  return <section className="space-y-5 p-5 sm:p-6" aria-label="Execution history">
    <Button size="sm" variant="ghost" onClick={onBack}>Back to task</Button>
    <header><h1 className="text-xl font-semibold">{entry?.source.kind === 'archive' ? 'Archived execution' : 'Historical execution'}</h1>
      <p className="mt-2 text-sm text-muted-foreground">Read-only history. This does not resume a model session or verify task completion.</p>
    </header>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {!entry && !error ? <p role="status">Loading execution…</p> : null}
    {entry ? sessionId
      ? <HistoricalTranscript key={sessionId} path={`${root}/sessions/${sessionId}/timeline?limit=100`} onBack={() => onSelectSession(null)} />
      : <HistoricalSessions path={`${root}/sessions?limit=100`} onSelectSession={onSelectSession} /> : null}
  </section>;
}

function HistoricalSessions({ path, onSelectSession }: { path: string; onSelectSession: (id: string) => void }) {
  const page = useHistoricalPage<ExecutionHistorySession>(path);
  return <div className="space-y-3">
    <h2 className="text-sm font-medium">Original sessions</h2>
    {page.loading && page.rows.length === 0 ? <p role="status">Loading sessions…</p> : null}
    {page.error ? <p role="alert" className="text-sm text-destructive">{page.error}</p> : null}
    {!page.loading && !page.error && page.rows.length === 0 ? <p className="text-sm text-muted-foreground">No recorded sessions.</p> : null}
    <ul className="space-y-2">{page.rows.map(session => <li key={session.id} className="rounded-md border border-border p-3 text-sm">
      <button className="text-left hover:underline" onClick={() => onSelectSession(session.id)}>{session.title ?? (session.role === 'summary' ? 'Summary session' : 'Work session')}</button>
      <p className="mt-1 text-xs text-muted-foreground">{session.state.replaceAll('_', ' ')}{session.role === 'summary' ? ' · Summary, not verification evidence' : ''}</p>
      {session.profileId || session.model ? <p className="mt-1 text-xs text-muted-foreground">{[session.profileId, session.model].filter(Boolean).join(' · ')}</p> : null}
    </li>)}</ul>
    {page.cursor && !page.denied ? <Button size="sm" variant="outline" disabled={page.loading} onClick={() => void page.load(page.cursor)}>Load older sessions</Button> : null}
    {page.error && !page.denied ? <Button size="sm" variant="outline" disabled={page.loading} onClick={() => void page.load(page.cursor)}>Try again</Button> : null}
  </div>;
}

function HistoricalTranscript({ path, onBack }: { path: string; onBack: () => void }) {
  const page = useHistoricalPage<HistoricalTimelineEntry>(path);
  return <div className="space-y-4">
    <Button size="sm" variant="outline" onClick={onBack}>Back to recorded sessions</Button>
    {page.loading && page.rows.length === 0 ? <p role="status">Loading transcript…</p> : null}
    {page.error ? <p role="alert" className="text-sm text-destructive">{page.error}</p> : null}
    {!page.loading && !page.error && page.rows.length === 0 ? <p className="text-sm text-muted-foreground">No recorded transcript entries.</p> : null}
    <ol className="space-y-4">{page.rows.map(event => <li key={event.eventId} className="min-w-0 rounded-md border border-border p-3 text-sm"><HistoricalEvent event={event} /></li>)}</ol>
    {page.cursor && !page.denied ? <Button size="sm" variant="outline" disabled={page.loading} onClick={() => void page.load(page.cursor)}>Load more transcript</Button> : null}
    {page.error && !page.denied ? <Button size="sm" variant="outline" disabled={page.loading} onClick={() => void page.load(page.cursor)}>Try again</Button> : null}
  </div>;
}

function HistoricalEvent({ event }: { event: HistoricalTimelineEntry }) {
  const payload = event.payload;
  const item = payload.item && typeof payload.item === 'object' && !Array.isArray(payload.item) ? payload.item as Record<string, unknown> : payload;
  if (event.kind === 'attention') return <><p className="font-medium">{payload.attention === 'permission' ? 'Permission requested' : payload.attention === 'permission_resolved' ? 'Permission resolved' : 'Recorded attention'}</p>{typeof payload.message === 'string' ? <p className="mt-2 whitespace-pre-wrap break-words">{payload.message}</p> : null}</>;
  if (['assistant_message', 'user_message', 'reasoning', 'agent_message'].includes(String(item.type)) && typeof item.text === 'string') return <><p className="mb-2 text-xs font-medium text-muted-foreground">{item.type === 'user_message' ? 'User' : item.type === 'reasoning' ? 'Reasoning' : 'Agent'}</p><p className="whitespace-pre-wrap break-words">{item.text}</p></>;
  if (item.type === 'tool_call') return <details><summary className="cursor-pointer break-words">{typeof item.name === 'string' ? item.name : 'Tool'} · {typeof item.status === 'string' ? item.status : 'Recorded'}</summary>{item.detail !== undefined ? <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(item.detail, null, 2)}</pre> : null}</details>;
  if (item.type === 'todo' && Array.isArray(item.items)) return <ul className="space-y-1">{item.items.map((value, index) => value && typeof value === 'object' && typeof value.text === 'string' ? <li key={index}>{value.text}{typeof value.status === 'string' ? ` · ${value.status.replaceAll('_', ' ')}` : ''}</li> : null)}</ul>;
  if ((item.type === 'notification' || item.type === 'error') && typeof item.message === 'string') return <p className="whitespace-pre-wrap break-words">{item.message}</p>;
  if (typeof item.text === 'string') return <p className="whitespace-pre-wrap break-words">{item.text}</p>;
  return <p className="text-muted-foreground">This recorded update format cannot be displayed.</p>;
}
