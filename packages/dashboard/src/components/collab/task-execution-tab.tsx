'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LatestRequest, pollResource } from '@/lib/collab/live';
import { collabFetch, ApiError } from '@/lib/collab/api';
import { capabilitiesFor, useMe } from '@/lib/collab/use-me';
import type { Command, Mapping, Project, Run, Session, Summary, TimelineEntry } from '@/lib/collab/types';
import { can, type TaskDetail } from './task-detail';
import {
  allAnswered,
  buildAnswers,
  choose,
  dismissLabel,
  emptyDraft,
  parseQuestions,
  pendingFromSession,
  showsTextInput,
  typeOther,
  type PendingRequest,
  type QuestionDraft,
} from '@/lib/collab/questions';

const TERMINAL_RUN_STATES = ['failed', 'cancelled'];

export function ExecutionTab({ detail, reload }: { detail: TaskDetail; reload: () => Promise<void> }) {
  const { me } = useMe();
  const project: Project | undefined = useMemo(
    () => me?.workspaces.flatMap((w) => w.projects).find((p) => p.id === detail.projectId),
    [me, detail.projectId],
  );

  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);

  const [runsError, setRunsError] = useState<string | null>(null);
  const [runsAccessDenied, setRunsAccessDenied] = useState(false);
  const runsRequests = useRef(new LatestRequest());
  const loadRuns = useCallback(async (parent?: AbortSignal) => {
    const signal = runsRequests.current.begin(parent);
    try {
      const result = await collabFetch<Run[]>(`/tasks/${detail.id}/runs`, { signal });
      if (!runsRequests.current.current(signal)) return;
      setRuns(result.data);
      setSelectedRunId(current => result.data.some(run => run.id === current) ? current : result.data[0]?.id ?? null);
      setRunsError(null);
      setRunsAccessDenied(false);
    } catch (err) {
      if (!runsRequests.current.current(signal)) return;
      const denied = err instanceof ApiError && [401, 403, 404].includes(err.status);
      if (denied) {
        setRuns([]);
        setSelectedRunId(null);
        setStartOpen(false);
      }
      setRunsAccessDenied(denied);
      setRunsError(denied
        ? 'Execution access is no longer available.'
        : 'Execution updates are temporarily unavailable. Showing last observed runs.');
    }
  }, [detail.id]);

  useEffect(() => {
    setRuns([]);
    setSelectedRunId(null);
    setRunsError(null);
    setRunsAccessDenied(false);
    const stop = pollResource(loadRuns);
    return () => { stop(); runsRequests.current.dispose(); };
  }, [loadRuns]);

  const canStart = !runsAccessDenied && can(detail, 'run.start') && capabilitiesFor(me, detail.projectId).includes('run.start');
  const internalRead = can(detail, 'internal.read');
  const activeRun = runs.find((r) => r.id === selectedRunId) ?? null;
  const retryAllowed =
    canStart && detail.execution?.latestRun != null && TERMINAL_RUN_STATES.includes(detail.execution.latestRun.state);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {runsError ? <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm lg:col-span-3">{runsError}</p> : null}
      <section aria-label="Runs" className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Runs</h2>
          {canStart ? (
            <div className="flex gap-1">
              {retryAllowed ? (
                <Button size="sm" variant="outline" onClick={() => setStartOpen(true)}>
                  Retry
                </Button>
              ) : null}
              <Button size="sm" onClick={() => setStartOpen(true)} disabled={retryAllowed}>
                Start AI work
              </Button>
            </div>
          ) : null}
        </div>
        {runs.length === 0 && !runsError ? (
          <p className="text-xs text-muted-foreground">
            {!internalRead || project?.executionDefaults
              ? 'No runs yet.'
              : 'Execution is not configured for this project.'}
          </p>
        ) : null}
        {runs.map((run) => (
          <button
            key={run.id}
            onClick={() => setSelectedRunId(run.id)}
            className={`rounded-md border px-2.5 py-2 text-left text-sm ${
              run.id === selectedRunId ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-secondary'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs">{run.id.slice(0, 8)}</span>
              <span className="text-xs text-muted-foreground">{run.state}</span>
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {run.stage} · {new Date(run.createdAt).toLocaleString()}
              {run.errorCode ? ` · ${run.errorCode}` : ''}
            </div>
          </button>
        ))}
      </section>

      <div className="lg:col-span-2">
        {activeRun ? (
          <RunDetail key={activeRun.id} run={activeRun} detail={detail} internalRead={internalRead} canSteer={can(detail, 'internal.read') && can(detail, 'run.steer') && capabilitiesFor(me, detail.projectId).includes('run.steer')} canCancel={can(detail, 'internal.read') && can(detail, 'run.cancel') && capabilitiesFor(me, detail.projectId).includes('run.cancel')} reloadRuns={loadRuns} reload={reload} />
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">Select a run to inspect it.</p>
        )}
      </div>

      {startOpen ? (
        <StartRunDialog
          detail={detail}
          project={project ?? null}
          retryOfRunId={retryAllowed ? (detail.execution?.latestRun?.id ?? null) : null}
          onClose={() => setStartOpen(false)}
          onQueued={async () => {
            setStartOpen(false);
            await loadRuns();
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}

function StartRunDialog({
  detail,
  project,
  retryOfRunId,
  onClose,
  onQueued,
}: {
  detail: TaskDetail;
  project: Project | null;
  retryOfRunId: string | null;
  onClose: () => void;
  onQueued: () => Promise<void>;
}) {
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [mappingsLoaded, setMappingsLoaded] = useState(false);
  const [mappingId, setMappingId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [model, setModel] = useState('');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  const canConfigure = can(detail, 'internal.read');
  const mappingRequests = useRef(new LatestRequest());

  useEffect(() => {
    const signal = mappingRequests.current.begin();
    setMappingsLoaded(false);
    if (!canConfigure) {
      setMappings([]);setMappingId('');setProfileId('');setModel('');setInstructions('');setMappingsLoaded(true);
      return () => mappingRequests.current.dispose();
    }
    void (async () => {
      try {
        const result = await collabFetch<Mapping[]>(`/projects/${detail.projectId}/mappings`,{signal});
        if (!mappingRequests.current.current(signal)) return;
        setMappings(result.data);
        const defaults = project?.executionDefaults ?? null;
        setMappingId(defaults?.mappingId ?? result.data[0]?.id ?? '');
        setProfileId(defaults?.profileId ?? result.data[0]?.defaultProfileId ?? '');
        setModel(defaults?.model ?? '');
        setInstructions(defaults?.instructions ?? '');
      } catch {
        if (mappingRequests.current.current(signal)) setMappings([]);
      } finally {
        if (mappingRequests.current.current(signal)) setMappingsLoaded(true);
      }
    })();
    return () => mappingRequests.current.dispose();
  }, [detail.projectId, project, canConfigure]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await collabFetch<Run>(`/tasks/${detail.id}/runs`, {
        method: 'POST',
        idempotencyKey: idempotencyKey.current,
        body: {
          expectedVersion: detail.version,
          ...(canConfigure ? {
            mappingId: mappingId || undefined,
            profileId: profileId || undefined,
            model: model || null,
            instructions: instructions || undefined,
          } : {}),
          retryOfRunId: retryOfRunId ?? undefined,
        },
      });
      await onQueued();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('This item changed. Refresh before saving.');
      } else if (err instanceof ApiError && err.status === 422) {
        setError('Execution is not configured for this project.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not queue the run.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <form
        role="dialog"
        aria-label="Start AI work"
        className="w-full max-w-md rounded-lg border border-border bg-background p-4"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="text-base font-semibold">Start AI work</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {retryOfRunId
            ? 'Queues a new run linked to the previous attempt. The host picks it up when online.'
            : 'Queues the run for the selected execution host. Nothing starts while the host is offline.'}
        </p>

        <div className="mt-3 flex flex-col gap-3">
          {canConfigure ? <>
          <label className="flex flex-col gap-1 text-xs">
            Repository mapping / host
            <select
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              value={mappingId}
              onChange={(e) => {
                setMappingId(e.target.value);
                const mapping = mappings.find((m) => m.id === e.target.value);
                setProfileId(mapping?.defaultProfileId ?? '');
              }}
              required
            >
              {mappings.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.repositoryKey} · {m.hostName ?? `host ${m.hostId.slice(0, 8)}`}
                  {m.hostReachability ? ` (${m.hostReachability}${m.hostLastSeenAt ? `, seen ${new Date(m.hostLastSeenAt).toLocaleString()}` : ''})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Agent profile
            <select
              aria-label="Agent profile"
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
              value={profileId}
              onChange={(e) => {
                setProfileId(e.target.value);
                const mapping = mappings.find((m) => m.id === mappingId);
                setModel('');
              }}
            >
              {(mappings.find((m) => m.id === mappingId)?.profiles ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.provider}
                  {p.model ? ` · ${p.model}` : ''}
                </option>
              ))}
              {(mappings.find((m) => m.id === mappingId)?.profiles ?? []).length === 0 ? (
                <option value={profileId}>{profileId || 'default profile'}</option>
              ) : null}
            </select>
          </label>
          {(mappings.find((m) => m.id === mappingId)?.allowedModels?.length ?? 0) > 0 ? (
            <label className="flex flex-col gap-1 text-xs">
              Model (host-allowed)
              <select
                aria-label="Model"
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">profile default</option>
                {mappings
                  .find((m) => m.id === mappingId)
                  ?.allowedModels!.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
              </select>
            </label>
          ) : (
            <p className="text-[11px] text-muted-foreground">Model follows the selected profile's configuration.</p>
          )}
          <label className="flex flex-col gap-1 text-xs">
            Instructions
            <textarea
              className="min-h-[72px] rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>
          </> : <p className="text-sm text-muted-foreground">Uses this project&apos;s configured execution settings. The host picks up the run when online.</p>}
          {error ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !mappingsLoaded || canConfigure && mappings.length === 0}>
              {busy ? 'Queueing…' : 'Queue run'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function RunDetail({
  run,
  detail,
  internalRead,
  canSteer,
  canCancel,
  reloadRuns,
  reload,
}: {
  run: Run;
  detail: TaskDetail;
  internalRead: boolean;
  canSteer: boolean;
  canCancel: boolean;
  reloadRuns: () => Promise<void>;
  reload: () => Promise<void>;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Summary[] | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryLoadError, setSummaryLoadError] = useState<string | null>(null);

  type UnresolvedCommand={id:string;kind:string;state:string;errorCode:string|null;createdAt:string;safeActions:('redeliver'|'cancel')[]};
  const [unresolvedCommands,setUnresolvedCommands]=useState<UnresolvedCommand[]>([]);
  const [reconcilingCommand,setReconcilingCommand]=useState<string|null>(null);
  async function reconcile(command:UnresolvedCommand,action:'redeliver'|'cancel'){
    setReconcilingCommand(command.id);setSummaryError(null);
    try{
      await collabFetch(`/commands/${command.id}/reconcile`,{method:'POST',body:{action}});
      await loadRun();await reloadRuns();await reload();
    }catch(err){setSummaryError(err instanceof ApiError?err.message:'Could not reconcile this request.');}
    finally{setReconcilingCommand(null);}
  }
  const [runError, setRunError] = useState<string | null>(null);
  const [runAccessDenied, setRunAccessDenied] = useState(false);
  const runRequests = useRef(new LatestRequest());
  const loadRun = useCallback(async (parent?: AbortSignal) => {
    const signal = runRequests.current.begin(parent);
    if (!internalRead) {
      setSessions([]);
      setUnresolvedCommands([]);
      setSelectedSessionId(null);
      return;
    }
    try {
      const result = await collabFetch<{run: Run; sessions: Session[]; unresolvedCommands: UnresolvedCommand[]}>(`/runs/${run.id}`, { signal });
      if (!runRequests.current.current(signal)) return;
      setSessions(result.data.sessions);
      setUnresolvedCommands(result.data.unresolvedCommands ?? []);
      setSelectedSessionId(current => result.data.sessions.some(session => session.id === current) ? current : result.data.sessions[0]?.id ?? null);
      setRunError(null);
      setRunAccessDenied(false);
    } catch (err) {
      if (!runRequests.current.current(signal)) return;
      const denied = err instanceof ApiError && [401, 403, 404].includes(err.status);
      if (denied) {
        setSessions([]);
        setUnresolvedCommands([]);
        setSelectedSessionId(null);
      }
      setRunAccessDenied(denied);
      setRunError(denied
        ? 'Execution access is no longer available.'
        : 'Execution updates are temporarily unavailable. Showing last observed sessions.');
    }
  }, [run.id, internalRead]);

  const [newSessionTitle,setNewSessionTitle]=useState('');
  const [newSessionInstructions,setNewSessionInstructions]=useState('');
  const [sessionBusy,setSessionBusy]=useState(false);
  const sessionRequestKey=useRef<string|null>(null);
  async function addSession(event:React.FormEvent){
    event.preventDefault();setSessionBusy(true);setSummaryError(null);
    try{
      const result=await collabFetch<{session:Session}>(`/runs/${run.id}/sessions`,{method:'POST',idempotencyKey:sessionRequestKey.current??(sessionRequestKey.current=crypto.randomUUID()),body:{title:newSessionTitle.trim(),instructions:newSessionInstructions}});
      sessionRequestKey.current=null;setNewSessionTitle('');setNewSessionInstructions('');
      await loadRun();setSelectedSessionId(result.data.session.id);await reloadRuns();
    }catch(err){setSummaryError(err instanceof ApiError?err.message:'Could not queue the session.');}
    finally{setSessionBusy(false);}
  }

  const summaryRequests = useRef(new LatestRequest());
  useEffect(() => {
    setSummaries([]);
    const stop = pollResource(async parent => {
      const signal = summaryRequests.current.begin(parent);
      try {
        const result=await collabFetch<Summary[]>(`/runs/${run.id}/summaries`,{signal});
        if (summaryRequests.current.current(signal)) { setSummaries(result.data); setSummaryLoadError(null); }
      } catch (err) {
        if (!summaryRequests.current.current(signal)) return;
        const denied = err instanceof ApiError && [401, 403, 404].includes(err.status);
        if (denied) setSummaries([]);
        setSummaryLoadError(denied ? 'Summary history is no longer available.' : 'Summary updates are temporarily unavailable. Showing last observed summaries.');
      }
    });
    return ()=>{stop();summaryRequests.current.dispose();};
  }, [run.id]);

  async function changeStage(stage: string) {
    setSummaryError(null);
    try {
      await collabFetch(`/runs/${run.id}`, {
        method: 'PATCH',
        body: { expectedVersion: run.version, stage },
      });
      await reloadRuns();
    } catch (err) {
      setSummaryError(err instanceof ApiError && err.status === 409 ? 'This item changed. Refresh before saving.' : 'Could not change the stage.');
    }
  }

  useEffect(()=>{
    const stop = pollResource(loadRun);
    return ()=>{stop();runRequests.current.dispose();};
  }, [loadRun]);

  const summaryRequestKey=useRef<string | null>(null);
  async function requestSummary() {
    setSummaryBusy(true);
    setSummaryError(null);
    try {
      await collabFetch(`/runs/${run.id}/summaries`, {
        method: 'POST',
        idempotencyKey: summaryRequestKey.current ?? (summaryRequestKey.current=crypto.randomUUID()),
        body: {},
      });
      summaryRequestKey.current=null;
      const result = await collabFetch<Summary[]>(`/runs/${run.id}/summaries`);
      setSummaries(result.data);
    } catch (err) {
      setSummaryError(
        err instanceof ApiError && err.status === 422
          ? 'Summary generation is disabled or unavailable.'
          : 'Could not request a summary.',
      );
    } finally {
      setSummaryBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Run status" className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm">
            <span className="font-medium">{run.state}</span>
            <span className="text-muted-foreground"> · stage {run.stage}</span>
            <span className="text-muted-foreground">
              {' '}· host {run.hostName ?? run.hostId.slice(0, 8)}
              {run.hostReachability ? ` (${run.hostReachability})` : ''}
              {run.hostLastSeenAt ? ` · last seen ${new Date(run.hostLastSeenAt).toLocaleString()}` : ''}
            </span>
            {run.lastObservedAt ? (
              <span className="text-muted-foreground"> · last observed {new Date(run.lastObservedAt).toLocaleString()}</span>
            ) : null}
            {run.workspaceId ? <div className="font-mono text-xs text-muted-foreground">workspace {run.workspaceId}</div> : null}
            {run.errorCode ? <div className="text-xs text-destructive">error: {run.errorCode}</div> : null}
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              Stage
              <select
                aria-label="Execution stage"
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                value={run.stage}
                disabled={!canSteer || runAccessDenied}
                onChange={(e) => void changeStage(e.target.value)}
              >
                <option value="design">design</option>
                <option value="development">development</option>
                <option value="test">test</option>
                <option value="in_review">in review</option>
              </select>
            </label>
            <Button size="sm" variant="outline" disabled={summaryBusy || !canSteer || runAccessDenied} onClick={() => void requestSummary()}>
              Request summary
            </Button>
          </div>
        </div>
        {runError ? <p role="status" className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">{runError}</p> : null}
        {summaryLoadError ? <p role="status" className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">{summaryLoadError}</p> : null}
        {summaryError ? (
          <p role="alert" className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs">
            {summaryError}
          </p>
        ) : null}
        {summaries && summaries.length > 0 ? (
          <div className="mt-3 flex flex-col gap-2">
            {summaries.map((s) => (
              <div key={s.id} className="rounded-md border border-border bg-background p-2 text-xs">
                <div className="text-muted-foreground">
                  {s.model ?? 'unknown model'} · {new Date(s.createdAt).toLocaleString()} · {s.visibility} · {s.provenance}
                  {s.sourceCursor?` · source ${s.sourceCursor}`:''}
                </div>
                <p className="mt-1 whitespace-pre-wrap">{s.body}</p>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {internalRead&&!runAccessDenied&&unresolvedCommands.length?<section aria-label="Execution requests" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
        <h2 className="text-sm font-medium">Execution requests</h2>
        <ul className="mt-2 flex flex-col gap-3">{unresolvedCommands.map(command=><li key={command.id} className="text-xs">
          <p>{command.kind.replaceAll('_',' ')} · {command.state} · {new Date(command.createdAt).toLocaleString()}</p>
          {command.state==='ambiguous'?<p className="mt-1">The host could not confirm the outcome. Retrying delivery asks the connector to reconcile this same request using its saved IDs. An uncertain prompt remains on hold.</p>:null}
          {command.safeActions.length>0&&canSteer?<div className="mt-2 flex gap-2">
            {command.safeActions.includes('redeliver')?<Button size="sm" variant="outline" disabled={!!reconcilingCommand} onClick={()=>void reconcile(command,'redeliver')}>Retry delivery of this request</Button>:null}
            {command.safeActions.includes('cancel')?<Button size="sm" variant="outline" disabled={!!reconcilingCommand} onClick={()=>void reconcile(command,'cancel')}>Close delivery request</Button>:null}
          </div>:null}
          {command.safeActions.includes('cancel')?<p className="mt-1 text-muted-foreground">Closing the delivery request leaves remote execution unconfirmed.</p>:null}
        </li>)}</ul>
      </section>:null}

      {can(detail,'run.start')&&internalRead&&!runAccessDenied?<form aria-label="New session" onSubmit={addSession} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-medium">New session</h2>
        <p className="text-xs text-muted-foreground">Uses this run's configured profile and workspace.</p>
        <Input aria-label="Session title" placeholder="Session title" required value={newSessionTitle} onChange={e=>setNewSessionTitle(e.target.value)}/>
        <textarea aria-label="Session instructions" placeholder="Initial instructions" className="min-h-20 rounded-md border border-border bg-background p-2 text-sm" value={newSessionInstructions} onChange={e=>setNewSessionInstructions(e.target.value)}/>
        <Button type="submit" size="sm" disabled={sessionBusy||!newSessionTitle.trim()||!run.workspaceId} className="self-start">Start session</Button>
      </form>:null}

      {sessions.length > 0 ? (
        <section aria-label="Sessions" className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-medium">Sessions</h2>
          <div className="mt-2 flex flex-wrap gap-1">
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedSessionId(s.id)}
                className={`rounded-md border px-2 py-1 text-xs ${
                  s.id === selectedSessionId ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-secondary'
                }`}
              >
                {s.title} · {s.state}
              </button>
            ))}
          </div>
          {selectedSessionId ? (
            <SessionPanel
              key={selectedSessionId}
              sessionId={selectedSessionId}
              run={run}
              detail={detail}
              internalRead={internalRead}
              canSteer={canSteer}
              canCancel={canCancel}
              onChanged={async () => {
                await loadRun();
                await reloadRuns();
                await reload();
              }}
            />
          ) : null}
        </section>
      ) : (
        <p className="text-xs text-muted-foreground">No sessions yet on this run.</p>
      )}
    </div>
  );
}

function SessionPanel({
  sessionId,
  run,
  detail,
  internalRead,
  canSteer,
  canCancel,
  onChanged,
}: {
  sessionId: string;
  run: Run;
  detail: TaskDetail;
  internalRead: boolean;
  canSteer: boolean;
  canCancel: boolean;
  onChanged: () => Promise<void>;
}) {
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null);
  const [draft, setDraft] = useState<QuestionDraft | null>(null);
  const [prompt, setPrompt] = useState('');
  const [behavior, setBehavior] = useState<'steer' | 'interrupt'>('steer');
  const [commandError, setCommandError] = useState<string | null>(null);

  const draftRequestId = useRef<string | null>(null);
  useEffect(() => {
    if (pendingRequest?.id && pendingRequest.id !== draftRequestId.current) {
      draftRequestId.current = pendingRequest.id;
      setDraft(null);
    }
  }, [pendingRequest?.id]);
  const active=['queued','launching','running','needs_input','cancel_requested','reconciling'].includes(run.state);
  const timelineRequests=useRef(new LatestRequest());
  const timelineAfter=useRef<string|null>(null);
  const [catchingUp,setCatchingUp]=useState(false);
  const loadTimeline = useCallback(async (parent?:AbortSignal) => {
    const signal=timelineRequests.current.begin(parent);
    if(!internalRead){setTimeline([]);setPendingRequest(null);return;}
    try {
      const entries:TimelineEntry[]=[];
      let after=timelineAfter.current;
      let next:string|null=null;
      let pages=0;
      do{
        const query=new URLSearchParams({limit:'100'});
        if(after)query.set('cursor',after);
        const page=await collabFetch<TimelineEntry[]>(`/sessions/${sessionId}/timeline?${query}`,{signal});
        entries.push(...page.data);
        next=page.nextCursor;
        after=page.cursor??next??after;
        pages+=1;
      }while(next&&pages<20);
      const pending=await collabFetch<PendingRequestDto|null>(`/sessions/${sessionId}/pending-request`,{signal});
      if(!timelineRequests.current.current(signal)) return;
      timelineAfter.current=after;
      setTimeline(current=>{const seen=new Set(current.map(entry=>entry.eventId));return [...current,...entries.filter(entry=>!seen.has(entry.eventId))];});
      setCatchingUp(Boolean(next));
      setPendingRequest(pending.data?pendingFromSession(pending.data):null);
      setTimelineError(null);
    } catch(err) {
      if(!timelineRequests.current.current(signal)) return;
      const denied = err instanceof ApiError && [401, 403, 404].includes(err.status);
      setPendingRequest(null);
      if (denied) {
        setTimeline([]);
        timelineAfter.current = null;
        setPrompt('');
        setDraft(null);
        draftRequestId.current = null;
      }
      setTimelineError(denied
        ? 'This session is no longer available.'
        : 'Live output or current request state is temporarily unavailable. Showing last observed output.');
    }
  }, [sessionId,internalRead]);

  useEffect(()=>{
    timelineAfter.current=null;
    setTimeline([]);setPendingRequest(null);setDraft(null);setCatchingUp(false);
    const stop=pollResource(loadTimeline);
    return ()=>{stop();timelineRequests.current.dispose();};
  },[loadTimeline]);

  async function sendCommand(body: Record<string, unknown>) {
    setCommandError(null);
    try {
      await collabFetch<Command>(`/sessions/${sessionId}/commands`, {
        method: 'POST',
        idempotencyKey: crypto.randomUUID(),
        body,
      });
      await onChanged();
      await loadTimeline();
    } catch (err) {
      setCommandError(
        err instanceof ApiError && err.status === 409
          ? 'This request is no longer active.'
          : err instanceof Error
            ? err.message
            : 'Command failed.',
      );
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      {catchingUp?<p aria-live="polite" className="text-xs text-muted-foreground">Catching up on saved session history…</p>:null}
      {!internalRead ? (
        <p className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
          Internal transcript and controls require operator permissions.
        </p>
      ) : (
        <>
          <div aria-label="Session timeline" className="max-h-72 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-xs">
            {timelineError ? (
              <p role="alert" className="text-destructive">{timelineError}</p>
            ) : timeline.length === 0 ? (
              <p className="text-muted-foreground">No output yet.</p>
            ) : null}
            {timeline.map((entry) => (
              <div key={entry.eventId} className="border-b border-border/40 py-1 last:border-0">
                <span className="text-muted-foreground">{new Date(entry.observedAt).toLocaleTimeString()} </span>
                <span className="rounded bg-secondary px-1 text-[10px]">{entry.kind}</span>
                <pre className="mt-0.5 whitespace-pre-wrap break-words">{safePayloadText(entry.payload)}</pre>
              </div>
            ))}
          </div>

          {pendingRequest ? (
            <PendingRequestCard
              key={pendingRequest.id}
              request={pendingRequest}
              draft={draft}
              setDraft={setDraft}
              canRespond={canSteer}
              onSend={(response) => void sendCommand({ kind: 'permission', requestId: pendingRequest.id, response })}
            />
          ) : null}

          {canSteer ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!prompt.trim()) return;
                void sendCommand({ kind: 'prompt', text: prompt.trim(), behavior });
                setPrompt('');
              }}
            >
              <div className="flex gap-2">
                <Input placeholder="Send a follow-up instruction…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
                <select
                  aria-label="Prompt behavior"
                  className="h-9 rounded-md border border-border bg-background px-2 text-xs"
                  value={behavior}
                  onChange={(e) => setBehavior(e.target.value as 'steer' | 'interrupt')}
                >
                  <option value="steer">steer</option>
                  <option value="interrupt">interrupt</option>
                </select>
                <Button size="sm" type="submit">
                  Send
                </Button>
              </div>
            </form>
          ) : null}

          {canCancel && active ? (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => void sendCommand({ kind: 'cancel' })}
            >
              Cancel current turn
            </Button>
          ) : null}
          {commandError ? <p role="alert" className="text-xs text-destructive">{commandError}</p> : null}
        </>
      )}
    </div>
  );
}

interface RequestLike {
  requestId: string;
  promptText: string;
  kind: 'permission' | 'question';
  choices?: { id: string; label: string }[];
}

/**
 * Fallback pending-request extraction from the normalized timeline: C emits
 * kind='attention' entries carrying permissionKind/name/input/actions (and the
 * legacy 'permission_request' shape). Resolution is signaled by a separate
 * resolved event, so an entry is pending only if no later resolution exists.
 */
function extractUnresolvedRequest(entries: TimelineEntry[]): PendingRequest | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const payload = entry.payload as Record<string, unknown>;
    const isRequest =
      (entry.kind === 'attention' && typeof payload.permissionKind === 'string') ||
      entry.kind === 'permission_request';
    if (!isRequest) continue;
    const laterResolution = entries.slice(i + 1).some((e) => e.kind === 'permission_resolved' || e.kind === 'attention_resolved');
    if (laterResolution) return null;
    const actions = Array.isArray(payload.actions)
      ? (payload.actions as { id: string; label: string }[]).map((a) => ({
          id: a.id,
          label: a.label,
          behavior: (/deny|reject/i.test(a.id) ? 'deny' : 'allow') as 'allow' | 'deny',
        }))
      : undefined;
    return {
      id: String(payload.requestId ?? payload.name ?? entry.eventId),
      kind: payload.permissionKind === 'question' ? 'question' : 'permission',
      name: String(payload.name ?? payload.summary ?? payload.title ?? 'The agent needs a decision'),
      title: String(payload.name ?? payload.summary ?? payload.title ?? 'The agent needs a decision'),
      input: recordish(payload.input),
      actions,
    };
  }
  return null;
}

function recordish(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function safePayloadText(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload, null, 1) ?? '';
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

interface PendingRequestDto {
  requestId: string;
  kind: 'permission' | 'question';
  promptText: string;
  choices?: { id: string; label: string }[] | null;
  inputSchema?: Record<string, unknown> | null;
  expiresAt?: string | null;
}

/**
 * Question/permission card following Flowly's session-question encoding
 * (MIT, pinned 13213f4): question forms render options plus "Other" text and
 * submit answers keyed by question header; approvals submit the host action id.
 */
function PendingRequestCard({
  request,
  draft,
  setDraft,
  canRespond,
  onSend,
}: {
  request: PendingRequest;
  draft: QuestionDraft | null;
  setDraft: (d: QuestionDraft | null) => void;
  canRespond: boolean;
  onSend: (response: { behavior: 'allow' | 'deny'; selectedActionId?: string; answers?: Record<string, string> }) => void;
}) {
  const questions = parseQuestions(request);

  if (questions) {
    const current = draft && draft.selected.length === questions.length ? draft : emptyDraft(questions);
    const answerable = allAnswered(questions, current);
    return (
      <div className="rounded-md border border-orange-500/40 bg-orange-500/10 p-2.5 text-sm">
        <p className="font-medium">{request.name ?? 'The agent needs your input'}</p>
        {canRespond ? (
          <>
            <div className="mt-2 flex flex-col gap-3">
              {questions.map((q, qIndex) => (
                <fieldset key={q.header} className="rounded-md border border-border bg-background p-2">
                  <legend className="px-1 text-xs font-medium">{q.question}</legend>
                  <div className="flex flex-col gap-1">
                    {q.options.map((option, oIndex) => (
                      <label key={option.label} className="flex items-center gap-2 text-xs">
                        <input
                          type={q.multiSelect ? 'checkbox' : 'radio'}
                          name={`${request.id}-${q.header}`}
                          checked={current.selected[qIndex]?.includes(oIndex) ?? false}
                          onChange={() => setDraft(choose(current, questions, qIndex, oIndex))}
                        />
                        <span>
                          {option.label}
                          {option.description ? <span className="ml-1 text-muted-foreground">{option.description}</span> : null}
                        </span>
                      </label>
                    ))}
                    {showsTextInput(q) ? (
                      <input
                        className="mt-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
                        placeholder={q.placeholder ?? (q.options.length > 0 ? 'Other…' : 'Type your answer…')}
                        value={current.other[qIndex] ?? ''}
                        aria-label={`Other answer for ${q.question}`}
                        onChange={(e) => setDraft(typeOther(current, questions, qIndex, e.target.value))}
                      />
                    ) : null}
                  </div>
                </fieldset>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                disabled={!answerable}
                // Wire contract: behavior allow|deny with header-keyed answers;
                // C maps them onto the provider's updatedInput server-side.
                onClick={() => onSend({ behavior: 'allow', answers: buildAnswers(questions, current) })}
              >
                Submit answers
              </Button>
              <Button size="sm" variant="outline" onClick={() => onSend({ behavior: 'deny' })}>
                {dismissLabel(questions) ?? 'Dismiss'}
              </Button>
            </div>
          </>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">Operator permissions required to respond.</p>
        )}
      </div>
    );
  }

  // Approval (tool/plan permission): submit the host-supplied action id.
  return (
    <div className="rounded-md border border-orange-500/40 bg-orange-500/10 p-2.5 text-sm">
      <p className="font-medium">{request.title ?? request.name ?? 'Permission request'}</p>
      {canRespond ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {(request.actions ?? []).map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant={action.behavior === 'deny' ? 'outline' : 'default'}
              onClick={() =>
                onSend(
                  action.behavior === 'deny'
                    ? { behavior: 'deny', selectedActionId: action.id }
                    : { behavior: 'allow', selectedActionId: action.id },
                )
              }
            >
              {action.label}
            </Button>
          ))}
          {(!request.actions || request.actions.length === 0) && (
            <>
              <Button size="sm" onClick={() => onSend({ behavior: 'allow' })}>
                Allow
              </Button>
              <Button size="sm" variant="outline" onClick={() => onSend({ behavior: 'deny' })}>
                Deny
              </Button>
            </>
          )}
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">Operator permissions required to respond.</p>
      )}
    </div>
  );
}
