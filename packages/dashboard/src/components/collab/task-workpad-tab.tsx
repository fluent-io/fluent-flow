'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LatestRequest, pollResource } from '@/lib/collab/live';
import { collabFetch, ApiError } from '@/lib/collab/api';
import type { Artifact, Check, CheckEvidence, Command, DeliverySnapshot, TaskDecision, Visibility } from '@/lib/collab/types';
import type { OpenQuestionView, WorkpadPlanView } from '@/lib/collab/types';
import { can, type TaskDetail } from './task-detail';

export function WorkpadTab({
  detail,
  setDetail,
  reload,
}: {
  detail: TaskDetail;
  setDetail: (t: TaskDetail) => void;
  reload: () => Promise<void>;
}) {
  const canAccept = can(detail, 'delivery.accept');
  const canInternal = can(detail, 'internal.read');
  const [checks, setChecks] = useState<(Check & { evidence?: CheckEvidence[] })[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [deliveries, setDeliveries] = useState<DeliverySnapshot[]>([]);

  const [loadError,setLoadError]=useState<string|null>(null);
  const collectionRequests=useRef(new LatestRequest());
  const loadAll = useCallback(async (parent?:AbortSignal) => {
    const signal=collectionRequests.current.begin(parent);
    try {
      const [checksResult,artifactsResult,deliveriesResult]=await Promise.all([
        collabFetch<(Check & {evidence?:CheckEvidence[]})[]>(`/tasks/${detail.id}/checks`,{signal}),
        collabFetch<Artifact[]>(`/tasks/${detail.id}/artifacts`,{signal}),
        canAccept||canInternal?collabFetch<DeliverySnapshot[]>(`/tasks/${detail.id}/deliveries`,{signal}):Promise.resolve({data:[]}),
      ]);
      if(!collectionRequests.current.current(signal)) return;
      setChecks(checksResult.data);setArtifacts(artifactsResult.data);setDeliveries(deliveriesResult.data);setLoadError(null);
    } catch(err) {
      if(!collectionRequests.current.current(signal)) return;
      setChecks([]);setArtifacts([]);setDeliveries([]);
      setLoadError(err instanceof ApiError?err.message:'Could not load the workpad.');
    }
  },[detail.id,canAccept,canInternal]);

  useEffect(()=>{
    const stop=pollResource(loadAll);
    return ()=>{stop();collectionRequests.current.dispose();};
  },[loadAll]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {loadError?<p role="alert" className="text-sm text-destructive lg:col-span-2">{loadError}</p>:null}
      <WorkpadPlanPanel detail={detail} canInternal={canInternal} onChanged={loadAll} />
      <OpenQuestionsPanel detail={detail} canInternal={canInternal} onChanged={loadAll} />
      <ChecksPanel detail={detail} checks={checks} canInternal={canInternal} onChanged={loadAll} />
      <ArtifactsPanel detail={detail} artifacts={artifacts} canInternal={canInternal} onChanged={loadAll} />
      <DeliveryPanel
        detail={detail}
        setDetail={setDetail}
        deliveries={deliveries}
        checks={checks}
        canAccept={canAccept}
        onChanged={async () => {
          await loadAll();
          await reload();
        }}
      />
      <WrapupPanel detail={detail} canInternal={canInternal} />
    </div>
  );
}

interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}



/** Versioned workpad plan: agent snapshots (read-only) and human edits. */
function WorkpadPlanPanel({
  detail,
  canInternal,
  onChanged,
}: {
  detail: TaskDetail;
  canInternal: boolean;
  onChanged: () => Promise<void>;
}) {
  const [plan, setPlan] = useState<WorkpadPlanView | null>(null);
  const [items, setItems] = useState<PlanItem[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const planRequests=useRef(new LatestRequest());
  const loadPlan = useCallback(async (parent?:AbortSignal) => {
    const signal=planRequests.current.begin(parent);
    try {
      const result = await collabFetch<{ plan: WorkpadPlanView | null }>(`/tasks/${detail.id}/plan`,{signal});
      if(planRequests.current.current(signal)) setPlan(result.data.plan);
    } catch(err) {
      if(!planRequests.current.current(signal)) return;
      setPlan(null);
      setError(err instanceof ApiError?err.message:'Could not load the plan.');
    }
  }, [detail.id]);

  useEffect(() => {
    const stop=pollResource(loadPlan);
    return ()=>{stop();planRequests.current.dispose();};
  }, [loadPlan]);

  async function savePlan() {
    setError(null);
    try {
      await collabFetch(`/tasks/${detail.id}/plan`, { method: 'POST', body: { items } });
      setEditing(false);
      await loadPlan();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the plan.');
    }
  }

  const statuses: PlanItem['status'][] = ['pending', 'in_progress', 'completed'];
  return (
    <section aria-label="Workpad plan" className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Plan</h2>
        {plan ? <span className="text-[11px] text-muted-foreground">latest · {plan.provenance}</span> : null}
      </div>
      {plan && !editing ? (
        <ol className="mt-2 flex flex-col gap-1 text-sm">
          {plan.items.map((item, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="rounded border border-border bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {item.status}
              </span>
              {item.text}
            </li>
          ))}
        </ol>
      ) : null}
      {!plan && !editing ? <p className="mt-2 text-xs text-muted-foreground">No plan recorded yet.</p> : null}
      {can(detail, 'task.write') && !editing ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => {
            setItems(plan?.items ?? [{ text: '', status: 'pending' }]);
            setEditing(true);
          }}
        >
          {plan ? 'Edit plan' : 'Create plan'}
        </Button>
      ) : null}
      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          {items.map((item, i) => (
            <div key={i} className="flex gap-2">
              <Input
                value={item.text}
                placeholder={`Step ${i + 1}`}
                aria-label={`Plan step ${i + 1}`}
                onChange={(e) =>
                  setItems((current) => current.map((it, index) => (index === i ? { ...it, text: e.target.value } : it)))
                }
              />
              <select
                aria-label={`Status for step ${i + 1}`}
                className="h-9 rounded-md border border-border bg-background px-2 text-xs"
                value={item.status}
                onChange={(e) =>
                  setItems((current) =>
                    current.map((it, index) => (index === i ? { ...it, status: e.target.value as PlanItem['status'] } : it)),
                  )
                }
              >
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setItems((current) => current.filter((_, index) => index !== i))}
              >
                ✕
              </Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setItems((c) => [...c, { text: '', status: 'pending' }])}>
            + Add step
          </Button>
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void savePlan()}>
              Save plan
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditing(false);
                setItems(plan?.items ?? []);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Open questions (agent confusions or human clarifications) resolved by humans. */
function OpenQuestionsPanel({
  detail,
  canInternal,
  onChanged,
}: {
  detail: TaskDetail;
  canInternal: boolean;
  onChanged: () => Promise<void>;
}) {
  const [questions, setQuestions] = useState<OpenQuestionView[]>([]);
  const [text, setText] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const questionRequests=useRef(new LatestRequest());
  const loadQuestions = useCallback(async (parent?:AbortSignal) => {
    const signal=questionRequests.current.begin(parent);
    if(!canInternal){setQuestions([]);return;}
    try {
      const result = await collabFetch<OpenQuestionView[]>(`/tasks/${detail.id}/questions`,{signal});
      if(questionRequests.current.current(signal)) setQuestions(result.data);
    } catch(err) {
      if(!questionRequests.current.current(signal)) return;
      setQuestions([]);
      setError(err instanceof ApiError?err.message:'Could not load open questions.');
    }
  }, [detail.id,canInternal]);

  useEffect(() => {
    const stop=pollResource(loadQuestions);
    return ()=>{stop();questionRequests.current.dispose();};
  }, [loadQuestions]);

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setError(null);
    try {
      await collabFetch(`/tasks/${detail.id}/questions`, { method: 'POST', body: { text: text.trim() } });
      setText('');
      await loadQuestions();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the question.');
    }
  }

  async function resolve(question: OpenQuestionView) {
    const answer = (answers[question.id] ?? '').trim();
    if (!answer) return;
    setError(null);
    try {
      await collabFetch(`/tasks/${detail.id}/questions/${question.id}/resolve`, {
        method: 'POST',
        body: { answer, expectedVersion: question.version },
      });
      await loadQuestions();
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? 'This item changed. Refresh before saving.' : 'Could not resolve the question.');
      await loadQuestions();
    }
  }

  return (
    <section aria-label="Open questions" className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Open questions</h2>
      <ul className="mt-2 flex flex-col gap-2">
        {questions.length === 0 ? <li className="text-xs text-muted-foreground">No open questions.</li> : null}
        {questions.map((question) => (
          <li key={question.id} className="rounded-md border border-border bg-background p-2.5 text-sm">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span
                className={`rounded border px-1 py-0.5 ${
                  question.state === 'open'
                    ? 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400'
                    : 'border-border bg-secondary'
                }`}
              >
                {question.state}
              </span>
              <span>{question.provenance}</span>
              <span>{new Date(question.createdAt).toLocaleString()}</span>
            </div>
            <p className="mt-1">{question.text}</p>
            {question.answer ? <p className="mt-1 text-emerald-600 dark:text-emerald-400">→ {question.answer}</p> : null}
            {question.state === 'open' && canInternal ? (
              <form
                className="mt-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void resolve(question);
                }}
              >
                <Input
                  placeholder="Your answer…"
                  aria-label={`Answer for: ${question.text}`}
                  value={answers[question.id] ?? ''}
                  onChange={(e) => setAnswers((current) => ({ ...current, [question.id]: e.target.value }))}
                />
                <Button size="sm" type="submit">
                  Resolve
                </Button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {canInternal ? (
        <form onSubmit={ask} className="mt-3 flex gap-2">
          <Input placeholder="Ask an open question…" value={text} onChange={(e) => setText(e.target.value)} />
          <Button size="sm" type="submit">
            Ask
          </Button>
        </form>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function ChecksPanel({
  detail,
  checks,
  canInternal,
  onChanged,
}: {
  detail: TaskDetail;
  checks: (Check & { evidence?: CheckEvidence[] })[];
  canInternal: boolean;
  onChanged: () => Promise<void>;
}) {
  const [evidenceDraft, setEvidenceDraft] = useState<{ checkId: string; status: string; commit: string; dirty: string } | null>(null);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function recordEvidence(checkId: string) {
    if (!evidenceDraft) return;
    setBusy(true);
    setError(null);
    try {
      await collabFetch(`/tasks/${detail.id}/checks/${checkId}/evidence`, {
        method: 'POST',
        body: {
          status: evidenceDraft.status,
          commit: evidenceDraft.commit.trim() || null,
          provenance: 'human',
          dirty:evidenceDraft.dirty==='unknown'?null:evidenceDraft.dirty==='dirty',
          runId:detail.execution?.latestRun?.id??null,
        },
      });
      setEvidenceDraft(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record evidence.');
    } finally {
      setBusy(false);
    }
  }

  async function addCheck(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !command.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await collabFetch(`/tasks/${detail.id}/checks`, {
        method: 'POST',
        body: { name: name.trim(), command: command.trim(), visibility: (canInternal ? 'internal' : 'client') as Visibility },
      });
      setName('');
      setCommand('');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the check.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Named checks" className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Named checks</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Exact commands with recorded evidence. Agent-reported results are marked; stale evidence is flagged against the current deliverable head.
      </p>
      <ul className="mt-3 flex flex-col gap-3">
        {checks.length === 0 ? <li className="text-xs text-muted-foreground">No checks defined.</li> : null}
        {checks.map((check) => {
          const latest = check.evidence?.[0] ?? null;
          const statusClass =
            latest?.status === 'passed'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : latest?.status === 'failed'
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : 'border-border bg-secondary text-muted-foreground';
          return (
            <li key={check.id} className="rounded-md border border-border bg-background p-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{check.name}</span>
                <span className={`rounded border px-1.5 py-0.5 text-[11px] ${statusClass}`}>
                  {latest ? `${latest.status}${latest.stale ? ' · stale' : ''}` : 'not run'}
                </span>
              </div>
              <code className="mt-1 block whitespace-pre-wrap break-all rounded bg-secondary px-1.5 py-1 text-[11px]">
                {check.command}
              </code>
              {latest ? (
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {latest.provenance} · {new Date(latest.observedAt).toLocaleString()}
                  {latest.commit ? ` · commit ${latest.commit.slice(0, 10)}` : ' · commit unknown'}
                  {latest.exitCode !== null ? ` · exit ${latest.exitCode}` : ''}
                  {` · worktree ${latest.dirty === false ? 'clean at capture' : latest.dirty === true ? 'dirty at capture' : 'unknown at capture'}`}
                  {latest.staleReason ? ` · ${latest.staleReason}` : ''}
                </div>
              ) : null}
              {check.evidence?.length?<details className="mt-2 text-xs"><summary className="cursor-pointer">Evidence history ({check.evidence.length})</summary><ul className="mt-1 flex flex-col gap-2">{check.evidence.map(evidence=><li key={evidence.id} className="rounded bg-secondary p-2">
                <p>{evidence.status}{evidence.stale?' · stale':''} · {evidence.provenance} · {new Date(evidence.observedAt).toLocaleString()}</p>
                <p>Commit: {evidence.commit??'unknown'} · worktree {evidence.dirty===false?'clean':evidence.dirty===true?'dirty':'unknown'} · exit {evidence.exitCode??'not reported'}</p>
                {evidence.staleReason?<p>{evidence.staleReason}</p>:null}
              </li>)}</ul></details>:null}
              {evidenceDraft?.checkId === check.id ? (
                <form
                  className="mt-2 flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void recordEvidence(check.id);
                  }}
                >
                  <select
                    aria-label={`Result for ${check.name}`}
                    className="h-8 rounded border border-border bg-background px-1.5 text-xs"
                    value={evidenceDraft.status}
                    onChange={(e) => setEvidenceDraft({ ...evidenceDraft, status: e.target.value })}
                  >
                    <option value="passed">passed</option>
                    <option value="failed">failed</option>
                    <option value="not_run">not run</option>
                  </select>
                  <Input
                    className="h-8 w-40 text-xs"
                    placeholder="Commit (optional)"
                    aria-label={`Commit for ${check.name}`}
                    value={evidenceDraft.commit}
                    onChange={(e) => setEvidenceDraft({ ...evidenceDraft, commit: e.target.value })}
                  />
                  <select aria-label={`Worktree state for ${check.name}`} className="h-8 rounded border border-border bg-background px-1.5 text-xs" value={evidenceDraft.dirty} onChange={event=>setEvidenceDraft({...evidenceDraft,dirty:event.target.value})}>
                    <option value="unknown">Worktree state unknown</option><option value="clean">Clean at capture</option><option value="dirty">Dirty at capture</option>
                  </select>
                  <Button size="sm" type="submit" disabled={busy}>
                    Record
                  </Button>
                </form>
              ) : (
                <button
                  className="mt-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setEvidenceDraft({ checkId: check.id, status: 'passed', commit: '', dirty:'unknown' })}
                >
                  + record evidence
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {can(detail, 'task.write') ? (
        <form onSubmit={addCheck} className="mt-3 flex flex-col gap-2">
          <Input placeholder="Check name (e.g. unit tests)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Exact command" value={command} onChange={(e) => setCommand(e.target.value)} />
          <Button size="sm" type="submit" disabled={busy} className="self-start">
            Add check
          </Button>
        </form>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function ArtifactsPanel({
  detail,
  artifacts,
  canInternal,
  onChanged,
}: {
  detail: TaskDetail;
  artifacts: Artifact[];
  canInternal: boolean;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [direction, setDirection] = useState<'input' | 'output'>('input');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addArtifact(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await collabFetch(`/tasks/${detail.id}/artifacts`, {
        method: 'POST',
        body: {
          direction,
          kind: 'text',
          name: name.trim(),
          visibility: (canInternal ? 'internal' : 'client') as Visibility,
          content: text,
        },
      });
      setName('');
      setText('');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the artifact.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Artifacts" className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Artifacts</h2>
      <ul className="mt-2 flex flex-col gap-2">
        {artifacts.length === 0 ? <li className="text-xs text-muted-foreground">No artifacts.</li> : null}
        {artifacts.map((artifact) => (
          <ArtifactRow key={artifact.id} artifact={artifact} canPublish={can(detail, 'task.write')} onChanged={onChanged} />
        ))}
      </ul>
      {can(detail, 'task.write') ? (
        <form onSubmit={addArtifact} className="mt-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <Input placeholder="Artifact name" value={name} onChange={(e) => setName(e.target.value)} />
            <select
              aria-label="Artifact direction"
              className="h-9 rounded-md border border-border bg-background px-2 text-xs"
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'input' | 'output')}
            >
              <option value="input">input</option>
              <option value="output">output</option>
            </select>
          </div>
          <textarea
            className="min-h-[56px] rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder="Text content or reference"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={busy} className="self-start">
            Add artifact
          </Button>
        </form>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function ArtifactRow({ artifact,canPublish,onChanged }: { artifact: Artifact;canPublish:boolean;onChanged:()=>Promise<void> }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [retrieving, setRetrieving] = useState(false);
  const [busy, setBusy] = useState(false);
  const previewRequests = useRef(new LatestRequest());

  useEffect(() => () => { previewRequests.current.dispose(); }, []);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const loadPreview = useCallback(async (parent?: AbortSignal) => {
    const signal = previewRequests.current.begin(parent);
    setBusy(true);
    try {
      const result = await collabFetch<{
        state?: 'queued' | 'offline' | 'unavailable'; reason?: string;
        content?: string; contentBase64?: string; mediaType?: string; truncated?: boolean;
      }>(`/artifacts/${artifact.id}/content`, { signal });
      if (!previewRequests.current.current(signal)) return;
      const content = result.data;
      setPreviewError(null);
      setPreviewUrl(null);
      setPreviewType(content.mediaType ?? null);
      if (content.state) {
        setRetrieving(content.state === 'queued' || content.state === 'offline');
        setPreview(content.reason ?? 'This preview is unavailable.');
        return;
      }
      setRetrieving(false);
      if (typeof content.content === 'string') {
        setPreview(content.content + (content.truncated ? '\n[Preview truncated]' : ''));
      } else if (content.contentBase64 && ['image/png','image/jpeg','image/webp','image/gif','application/pdf'].includes(content.mediaType ?? '')) {
        const bytes=Uint8Array.from(atob(content.contentBase64), c=>c.charCodeAt(0));
        setPreview(null);
        setPreviewUrl(URL.createObjectURL(new Blob([bytes], { type: content.mediaType })));
      } else {
        setPreview('This file is available as a download.');
      }
    } catch (err) {
      if (!previewRequests.current.current(signal)) return;
      setPreview(null);
      setPreviewUrl(null);
      setRetrieving(false);
      setPreviewError(err instanceof ApiError && [401,403,404].includes(err.status) ? 'This artifact is no longer available.' : 'This preview is unavailable.');
    } finally {
      if (previewRequests.current.current(signal)) setBusy(false);
    }
  }, [artifact.id]);

  useEffect(() => {
    if (!retrieving) return;
    return pollResource(loadPreview);
  }, [retrieving, loadPreview]);

  return (
    <li className="rounded-md border border-border bg-background p-2.5 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{artifact.name}</span>
        <span className="text-[11px] text-muted-foreground">{artifact.direction} · {artifact.visibility} · {artifact.provenance}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void loadPreview()}>Preview</Button>
        {canPublish?<Button size="sm" variant="ghost" disabled={busy} onClick={()=>void (async()=>{
          setBusy(true);
          try {await collabFetch(`/tasks/${artifact.taskId}/artifacts/${artifact.id}/publication`,{method:'POST',body:{expectedVersion:artifact.version,visibility:artifact.visibility==='internal'?'client':'internal'}});await onChanged();}
          catch(err){setPreviewError(err instanceof ApiError?err.message:'Could not update artifact visibility.');}
          finally{setBusy(false);}
        })()}>{artifact.visibility==='internal'?'Share with client':'Make internal'}</Button>:null}
        {previewUrl || (preview && !retrieving && !previewError) ? <a className="text-xs underline" href={`/api/collab/v1/artifacts/${artifact.id}/content?raw=1`} target="_blank" rel="noreferrer">Open file</a> : null}
        {previewError ? <span role="alert" className="text-xs text-destructive">{previewError}</span> : null}
      </div>
      {preview ? <pre aria-live="polite" className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-secondary px-2 py-1 text-[11px]">{preview}</pre> : null}
      {previewUrl && previewType?.startsWith('image/') ? <img src={previewUrl} alt={artifact.name} className="mt-2 max-h-80 max-w-full rounded outline outline-1 outline-border" /> : null}
      {previewUrl && previewType === 'application/pdf' ? <iframe title={artifact.name} src={previewUrl} sandbox="" className="mt-2 h-80 w-full rounded border border-border" /> : null}
    </li>
  );
}

function DeliveryPanel({
  detail,
  setDetail,
  deliveries,
  checks,
  canAccept,
  onChanged,
}: {
  detail: TaskDetail;
  setDetail: (t: TaskDetail) => void;
  deliveries: DeliverySnapshot[];
  checks: (Check & { evidence?: CheckEvidence[] })[];
  canAccept: boolean;
  onChanged: () => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [decisionNote, setDecisionNote] = useState('');
  const canSubmitDelivery = can(detail, 'task.write') && can(detail, 'internal.read');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ackIds, setAckIds] = useState<string[]>([]);
  const [review, setReview] = useState<{
    deliveryId: string; runId: string | null; headCommit: string | null; dirty: boolean | null;
    evidenceRevision: string; openItems: { id: string; label: string }[];
  } | null>(null);
  const reviewRequests = useRef(new LatestRequest());
  const reviewRevision = useRef<string | null>(null);
  const canViewHistory = canAccept || can(detail, 'internal.read');
  const [decisions, setDecisions] = useState<TaskDecision[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const historyRequests = useRef(new LatestRequest());
  const historyPageBudget = useRef(20);
  useEffect(() => { setDecisionNote(''); }, [detail.id, canAccept]);
  const loadHistory = useCallback(async (parent?: AbortSignal) => {
    if (!canViewHistory) return;
    const signal = historyRequests.current.begin(parent);
    setHistoryLoading(true);
    try {
      const collected = new Map<string, TaskDecision>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < historyPageBudget.current; page++) {
        seenCursors.add(cursor ?? '');
        const params = new URLSearchParams({ limit: '50' });
        if (cursor) params.set('cursor', cursor);
        const result = await collabFetch<TaskDecision[]>(`/tasks/${detail.id}/decisions?${params}`, { signal });
        if (!historyRequests.current.current(signal)) return;
        for (const decision of result.data) if (!collected.has(decision.id)) collected.set(decision.id, decision);
        cursor = result.nextCursor;
        if (!cursor) break;
        if (seenCursors.has(cursor)) throw new Error('Repeated decision cursor');
      }
      setDecisions([...collected.values()]);
      setHistoryHasMore(Boolean(cursor));
      setHistoryError(null);
    } catch (err) {
      if (!historyRequests.current.current(signal)) return;
      setDecisions([]);
      setHistoryHasMore(false);
      setHistoryError(err instanceof ApiError && [401, 403, 404].includes(err.status)
        ? 'Decision history is no longer available.'
        : 'Decision history is temporarily unavailable.');
    } finally {
      if (historyRequests.current.current(signal)) setHistoryLoading(false);
    }
  }, [detail.id, canViewHistory]);

  useEffect(() => {
    setDecisions(null);
    setHistoryError(null);
    setHistoryHasMore(false);
    historyPageBudget.current = 20;
    if (!canViewHistory) return;
    const stop = pollResource(loadHistory);
    return () => { stop(); historyRequests.current.dispose(); };
  }, [loadHistory, canViewHistory]);

  useEffect(() => {
    setReview(null);
    setAckIds([]);
    reviewRevision.current = null;
    if (!canAccept || !deliveries[0]) return;
    const stop = pollResource(async parent => {
      const signal = reviewRequests.current.begin(parent);
      try {
        const result = await collabFetch<NonNullable<typeof review>>(`/tasks/${detail.id}/delivery-review`, { signal });
        if (!reviewRequests.current.current(signal)) return;
        if (reviewRevision.current !== result.data.evidenceRevision) setAckIds([]);
        reviewRevision.current = result.data.evidenceRevision;
        setReview(result.data);
      } catch (err) {
        if (!reviewRequests.current.current(signal)) return;
        setReview(null);
        setAckIds([]);
        setError(err instanceof ApiError ? err.message : 'Could not load delivery evidence.');
      }
    });
    return () => { stop(); reviewRequests.current.dispose(); };
  }, [detail.id, canAccept, deliveries[0]?.id]);

  const openItems = review?.openItems ?? [];

  async function submitDelivery(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmitDelivery) return;
    setBusy(true);
    setError(null);
    try {
      await collabFetch(`/tasks/${detail.id}/deliveries`, {
        method: 'POST',
        body: { expectedVersion: detail.version, note: note.trim(), artifactIds: [], checkEvidenceIds: [] },
      });
      setNote('');
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit for review.');
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'accept' | 'cancel' | 'reopen') {
    setBusy(true);
    setError(null);
    try {
      // Server returns {decision, acknowledged}; the authoritative task comes
      // from the reload below.
      await collabFetch<{ decision: string; acknowledged: boolean }>(`/tasks/${detail.id}/decisions`, {
        method: 'POST',
        body: {
          expectedVersion: detail.version,
          decision,
          note: decisionNote.trim(),
          acknowledgedOpenItemIds: ackIds,
          ...(decision === 'accept' ? { reviewSnapshot: review } : {}),
        },
      });
      setAckIds([]);
      setDecisionNote('');
      await loadHistory();
      await onChanged();
    } catch (err) {
      if (err instanceof ApiError && [401, 403, 404].includes(err.status)) setDecisionNote('');
      if (err instanceof ApiError && err.status === 422) {
        setError('Review the remaining delivery items before accepting.');
      } else if (err instanceof ApiError && err.status === 409) {
        setAckIds([]);
        setError(err.code === 'review_changed' ? 'Delivery evidence changed. Review the current items before accepting.' : 'This item changed. Refresh before saving.');
      } else {
        setError(err instanceof Error ? err.message : 'Decision failed.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Review and delivery" className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Review and delivery</h2>

      {openItems.length > 0 ? (
        <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-sm">
          <p className="font-medium">Open items ({openItems.length})</p>
          <ul className="mt-1 flex flex-col gap-1 text-xs">
            {openItems.map((item) => (
              <li key={item.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`Acknowledge ${item.label}`}
                  checked={ackIds.includes(item.id)}
                  onChange={(e) =>
                    setAckIds((current) => (e.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id)))
                  }
                />
                <span>{item.label}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <form onSubmit={submitDelivery} className="mt-3 flex flex-col gap-2">
        <textarea
          className="min-h-[56px] rounded-md border border-border bg-background px-3 py-2 text-sm"
          placeholder="Delivery note — what changed, what was tested"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {canSubmitDelivery ? <Button size="sm" type="submit" disabled={busy} className="self-start">
          Submit for review
        </Button> : null}
      </form>

      {deliveries.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {deliveries.map((delivery) => (
            <div key={delivery.id} className="rounded-md border border-border bg-background p-2 text-xs">
              <div className="text-muted-foreground">
                {new Date(delivery.createdAt).toLocaleString()} · by {delivery.createdBy}
              </div>
              <p className="mt-1 whitespace-pre-wrap">{delivery.note}</p>
            </div>
          ))}
        </div>
      ) : null}

      {canAccept ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <label className="flex w-full flex-col gap-1 text-xs">
            Decision note (optional)
            <textarea
              aria-label="Decision note"
              className="min-h-[56px] rounded-md border border-border bg-background px-3 py-2 text-sm"
              maxLength={20000}
              value={decisionNote}
              onChange={event => setDecisionNote(event.target.value)}
            />
          </label>
          <Button size="sm" disabled={busy || !review || detail.status !== 'review' || openItems.some(item => !ackIds.includes(item.id))} onClick={() => void decide('accept')}>
            Accept (Done)
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide('cancel')}>
            Cancel task
          </Button>
          {detail.status === 'done' || detail.status === 'cancelled' ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide('reopen')}>
              Reopen
            </Button>
          ) : null}
        </div>
      ) : null}

      {canViewHistory ? (
        <section aria-label="Decision history" className="mt-4 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Decision history</h3>
            <Button size="sm" variant="ghost" disabled={historyLoading} onClick={() => void loadHistory()}>Refresh history</Button>
          </div>
          {historyError ? <p role="alert" className="mt-2 text-xs text-destructive">{historyError}</p> : null}
          {decisions === null && !historyError ? <p className="mt-2 text-xs text-muted-foreground">Loading decision history…</p> : null}
          {decisions?.length === 0 && !historyError && !historyLoading ? <p className="mt-2 text-xs text-muted-foreground">No decisions recorded yet.</p> : null}
          <ol className="mt-2 flex flex-col gap-2">
            {decisions?.map(decision => (
              <li key={decision.id} className="rounded-md border border-border bg-background p-2 text-xs">
                <p className="font-medium">{{ accept: 'Accepted', cancel: 'Cancelled', reopen: 'Reopened' }[decision.decision]} · task version {decision.taskVersion}</p>
                <time dateTime={decision.createdAt} className="text-muted-foreground">{new Date(decision.createdAt).toLocaleString()}</time>
                <p className="mt-1 whitespace-pre-wrap break-words">{decision.note || 'No decision note.'}</p>
                <p className="mt-1">Acknowledged open items: {decision.acknowledgedOpenItemIds.length}</p>
                {decision.reviewSnapshot ? (
                  <div className="mt-1 text-muted-foreground">
                    <p className="break-all">Reviewed commit: {decision.reviewSnapshot.headCommit ?? 'unknown'}</p>
                    <p>Worktree at decision: {decision.reviewSnapshot.dirty === false ? 'clean' : decision.reviewSnapshot.dirty === true ? 'dirty' : 'unknown'}</p>
                  </div>
                ) : decision.decision === 'accept' ? <p className="mt-1 text-muted-foreground">Reviewed snapshot not recorded.</p> : null}
              </li>
            ))}
          </ol>
          {historyHasMore ? <Button className="mt-2" size="sm" variant="outline" disabled={historyLoading} onClick={() => { historyPageBudget.current += 20; void loadHistory(); }}>Load older decisions</Button> : null}
        </section>
      ) : null}
    </section>
  );
}

function WrapupPanel({ detail, canInternal }: { detail: TaskDetail; canInternal: boolean }) {
  type ResultCommand=Command & {result?:{owned?:boolean;git?:{ok?:boolean;uncommitted?:number;untracked?:number;unpushed?:number};sessions?:{status:string}[];blockers?:{code:string;count?:number}[];checkedAt?:string;ok?:boolean;phase?:string;archivedSessionIds?:string[]}|null};
  const [preflight,setPreflight]=useState<ResultCommand|null>(null);
  const [wrapup,setWrapup]=useState<ResultCommand|null>(null);
  const [commandId,setCommandId]=useState<string|null>(null);
  const [currentCommand,setCurrentCommand]=useState<ResultCommand|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const commandRequests=useRef(new LatestRequest());
  const runId=detail.execution?.latestRun?.id??null;
  const allowed=canInternal&&can(detail,'run.steer');

  useEffect(()=>{
    if(!commandId||!allowed) return;
    const stop=pollResource(async parent=>{
      const signal=commandRequests.current.begin(parent);
      try{
        const result=await collabFetch<ResultCommand>(`/commands/${commandId}`,{signal});
        if(!commandRequests.current.current(signal)) return;
        setCurrentCommand(result.data);
        if(result.data.kind==='wrapup_preflight') setPreflight(result.data); else setWrapup(result.data);
      }catch(err){
        if(!commandRequests.current.current(signal)) return;
        setPreflight(null);setWrapup(null);setCurrentCommand(null);
        setError(err instanceof ApiError?err.message:'Could not load the cleanup result.');
      }
    });
    return ()=>{stop();commandRequests.current.dispose();};
  },[commandId,allowed]);

  async function queue(mode?:'archive_sessions'|'archive_owned_workspace'){
    if(!runId) return;
    setBusy(true);setError(null);setCurrentCommand(null);
    try{
      const response=await collabFetch<{commandId:string}>(`/runs/${runId}/${mode?'wrap-ups':'wrap-up-preflights'}`,{method:'POST',idempotencyKey:crypto.randomUUID(),body:mode?{preflightId:preflight?.id,mode}:{}});
      setCommandId(response.data.commandId);
      if(!mode){setPreflight(null);setWrapup(null);}
    }catch(err){setError(err instanceof ApiError?err.message:'Could not queue the cleanup request.');}
    finally{setBusy(false);}
  }

  if(!allowed||!runId) return null;
  const report=preflight?.result;
  const fresh=!!report?.checkedAt&&Date.now()-new Date(report.checkedAt).getTime()<60000;
  const safe=preflight?.state==='applied'&&report?.owned===true&&report.git?.ok===true&&Array.isArray(report.blockers)&&report.blockers.length===0&&fresh&&detail.execution?.hostReachability==='online';
  const pending=!!commandId&&(!currentCommand||!['applied','failed','ambiguous','cancelled'].includes(currentCommand.state));
  const labels:Record<string,string>={uncommitted_changes:'Uncommitted changes',untracked_files:'Untracked files',unpushed_commits:'Unpushed commits',sessions_running:'Active sessions',unrecognized_sessions:'Sessions owned elsewhere',not_owned:'Workspace is not owned by this run',workspace_not_owned:'Workspace is not owned by this run',git_unreadable:'Worktree state is unavailable',session_listing_failed:'Session state is unavailable',unknown_mode:'Unsupported cleanup action'};
  return <section aria-label="Wrap-up" className="rounded-lg border border-border bg-card p-4">
    <h2 className="text-sm font-medium">Session wrap-up</h2>
    <p className="mt-1 text-xs text-muted-foreground">Check the workspace before archiving. Uncommitted, untracked, unpushed or shared work blocks cleanup.</p>
    <Button size="sm" className="mt-2" variant="outline" disabled={busy||pending} onClick={()=>void queue()}>Run preflight</Button>
    {pending?<p aria-live="polite" className="mt-2 text-xs text-muted-foreground">{detail.execution?.hostReachability==='online'?'Waiting for the execution host.':'Queued until the execution host reconnects.'}</p>:null}
    {report?<div className="mt-2 rounded-md border border-border bg-background p-2 text-xs">
      <div>Uncommitted files: {report.git?.ok?report.git.uncommitted??'unknown':'unknown'}</div>
      <div>Untracked files: {report.git?.ok?report.git.untracked??'unknown':'unknown'}</div>
      <div>Unpushed commits: {report.git?.ok?report.git.unpushed??'unknown':'unknown'}</div>
      <div>Active sessions: {report.sessions?report.sessions.filter(s=>['running','initializing','pending'].includes(s.status)).length:'unknown'}</div>
      {report.blockers?.length?<ul className="mt-1 list-inside list-disc">{report.blockers.map((blocker,i)=><li key={i}>{labels[blocker.code]??'The host could not confirm safe cleanup.'}{blocker.count!==undefined?` (${blocker.count})`:''}</li>)}</ul>:null}
      {!fresh?<p className="mt-1 text-amber-600">Preflight expired. Run it again before archiving.</p>:null}
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" disabled={busy||pending||!safe} onClick={()=>void queue('archive_sessions')}>Archive terminal sessions</Button>
        <Button size="sm" variant="outline" disabled={busy||pending||!safe} onClick={()=>void queue('archive_owned_workspace')}>Archive owned workspace</Button>
      </div>
    </div>:null}
    {wrapup?<p aria-live="polite" className="mt-2 text-xs">{wrapup.state==='applied'&&wrapup.result?.ok===true?'Archival confirmed. Work history is retained.':wrapup.state==='failed'?'Cleanup was blocked. Review the preflight and try again.':wrapup.state==='ambiguous'?'Cleanup outcome is uncertain. Reconcile it before retrying.':'Archival is pending.'}</p>:null}
    {error?<p role="alert" className="mt-2 text-xs text-destructive">{error}</p>:null}
  </section>;
}
