'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, collabFetch, collabFetchAll } from '@/lib/collab/api';
import { createClaimEventState, reduceClaimEvents, type ClaimEventEntity, type ClaimEventState } from '@/lib/collab/claim-events';
import { markClaimRead } from '@/lib/collab/claim-progress';
import { LatestRequest, pollResource } from '@/lib/collab/live';
import type {
  ClaimExecution,
  ClaimExecutionBadge,
  ClaimExecutionEvent,
  ClaimExecutionRequest,
  StartClaimExecutionResult,
  SubmitClaimCommandResult,
} from '@/lib/collab/types';
import { capabilitiesFor, useMe } from '@/lib/collab/use-me';
import type { TaskDetail } from './task-detail';
import { ChatHandoffControls } from './chat-handoff-controls';

const MAX_PAGES = 20;
const selectClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const textareaClass = 'min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

type FormValue = string | number | boolean | string[];
type SchemaProperty = Record<string, unknown>;

function newKey(): string {
  return crypto.randomUUID();
}
function deterministicJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return current;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(current as Record<string, unknown>).sort()) ordered[key] = (current as Record<string, unknown>)[key];
    return ordered;
  }) ?? '';
}


function isDenied(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

function pagePath(path: string, cursor: string): string {
  if (!cursor) return path;
  const joiner = path.includes('?') ? '&' : '?';
  return `${path}${joiner}cursor=${encodeURIComponent(cursor)}`;
}

function cursorAfter(seq: number): string {
  const encoded = btoa(JSON.stringify({ s: seq }));
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Pending',
    claimed: 'Claimed',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    expired: 'Expired',
  };
  return labels[status] ?? status;
}

function runnerLabel(state: string): string {
  if (state === 'running') return 'Streaming';
  if (state === 'requires_action') return 'Needs input';
  if (state === 'idle') return 'Idle';
  return state;
}

function textBlocks(content: unknown): Array<{ text?: string; type?: string }> {
  if (!Array.isArray(content)) return [];
  return content.map((block) => block && typeof block === 'object' ? block as { text?: string; type?: string } : { type: 'unknown' });
}

function schemaProperty(value: unknown): SchemaProperty | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as SchemaProperty : null;
}

function EntityView({ entity, compact = false }: { entity: ClaimEventEntity; compact?: boolean }) {
  if (compact && ['tool_call','terminal','agent_thought'].includes(entity.type)) return <details className="border-b border-border py-3"><summary className="cursor-pointer text-xs text-muted-foreground">{typeof entity.title === 'string' ? entity.title : entity.type === 'agent_thought' ? 'Agent reasoning' : 'Tool activity'}</summary><div className="mt-3"><EntityView entity={entity}/></div></details>;
  if (typeof entity.type !== 'string') return <article className="rounded-md border border-border p-3 text-xs text-muted-foreground">unknown</article>;
  if (['agent_message', 'user_message', 'agent_thought', 'session_message'].includes(entity.type)) {
    return (
      <article className={compact ? entity.type === 'user_message' ? 'ml-8 rounded-md bg-secondary p-4' : 'py-4' : 'rounded-md border border-border bg-background/40 p-3'}>
        <div className="mb-2 text-xs text-muted-foreground">{compact ? entity.type === 'user_message' ? 'You' : 'Agent' : entity.type.replaceAll('_', ' ')}</div>
        <div className="space-y-1 whitespace-pre-wrap break-words text-sm">
          {textBlocks(entity.content).map((block, index) => block.type === 'text'
            ? <span key={index}>{typeof block.text === 'string' ? block.text : ''}</span>
            : <span key={index} className="block text-xs text-muted-foreground">[{block.type ?? 'unsupported'} content]</span>)}
        </div>
        {compact && typeof entity.commandStatus === 'string' ? <p className="mt-2 text-[11px] text-muted-foreground">{{acked:'Accepted',pending:'Queued',delivered:'Delivered · awaiting acceptance',failed:'Rejected',uncertain:'Delivery uncertain',cancelled:'Cancelled'}[entity.commandStatus] ?? entity.commandStatus}</p> : null}
      </article>
    );
  }
  if (entity.type === 'terminal') {
    return (
      <article className="rounded-md border border-border bg-black/30 p-3">
        <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>Terminal</span>
          {entity.exitStatus !== undefined && <span>Exited</span>}
        </div>
        {entity.truncated === true && <div className="mb-1 text-xs text-amber-400">Output truncated</div>}
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{typeof entity.output === 'string' ? entity.output : ''}</pre>
      </article>
    );
  }
  if (entity.type === 'tool_call') {
    return (
      <article className="rounded-md border border-border bg-background/40 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong>{typeof entity.title === 'string' ? entity.title : typeof entity.name === 'string' ? entity.name : 'Tool activity'}</strong>
          <span className="rounded border border-border px-1.5 py-0.5 text-[11px]">{typeof entity.status === 'string' ? entity.status : 'pending'}</span>
        </div>
        <div className="mt-2 space-y-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {Array.isArray(entity.content) && entity.content.map((item, index) => {
            const itemRecord = item && typeof item === 'object' ? item as Record<string, unknown> : {};
            const nested = itemRecord.content && typeof itemRecord.content === 'object' ? itemRecord.content as Record<string, unknown> : null;
            return nested?.type === 'text' && typeof nested.text === 'string'
              ? <div key={index}>{nested.text}</div>
              : <div key={index}>[{typeof itemRecord.type === 'string' ? itemRecord.type : 'tool'} output]</div>;
          })}
        </div>
      </article>
    );
  }
  if (entity.type === 'plan') {
    return (
      <article className="rounded-md border border-border bg-background/40 p-3">
        <strong className="text-sm">Plan</strong>
        <ul className="mt-2 space-y-1 text-sm">
          {Array.isArray(entity.entries) && entity.entries.map((entry, index) => {
            const value = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
            return <li key={index} className="flex gap-2"><span className="text-muted-foreground">{typeof value.status === 'string' ? value.status : 'pending'}</span><span>{typeof value.content === 'string' ? value.content : ''}</span></li>;
          })}
        </ul>
      </article>
    );
  }
  return <article className="rounded-md border border-border p-3 text-xs text-muted-foreground">{entity.type.replaceAll('_', ' ')}</article>;
}

type PromptHistory = {commandId:number;text:string;status:string;createdAt:string;messageId?:string|null};
function Timeline({ state, compact = false, prompts = [] }: { state: ClaimEventState; compact?: boolean; prompts?: PromptHistory[] }) {
  const entries:ClaimEventEntity[] = [...state.entities, ...prompts.filter(p=>!p.messageId||!state.entities.some(e=>e.type==='user_message'&&e.id===p.messageId)).map(p=>({key:`prompt:${p.commandId}`,id:String(p.commandId),type:'user_message',firstSeenAt:p.createdAt,commandStatus:p.status,content:[{type:'text',text:p.text}]}))];
  if(compact) entries.sort((a,b)=>String(a.firstSeenAt??'').localeCompare(String(b.firstSeenAt??'')));
  return (
    <div role="log" tabIndex={0} aria-label="Execution transcript" className={compact ? 'space-y-4 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring' : 'max-h-[34rem] space-y-2 overflow-auto rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'}>
      {entries.map((entity) => <EntityView key={entity.key} entity={entity} compact={compact} />)}
      {state.notices.map((notice) => (
        <div key={`notice:${notice.seq}`} className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <strong>{notice.title}</strong>{notice.description && <p className="mt-1 text-muted-foreground">{notice.description}</p>}
        </div>
      ))}
      {state.unknown.map((item) => (
        <div key={`unknown:${item.seq}`} className="rounded-md border border-border p-3 text-xs">
          <div className="font-medium">{item.name}</div><pre className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{item.text}</pre>
        </div>
      ))}
      {state.usage && <div className="text-xs text-muted-foreground">{String(state.usage.used ?? '—')} / {String(state.usage.size ?? '—')} tokens</div>}
      {state.entities.length === 0 && state.notices.length === 0 && state.unknown.length === 0 && <div className="p-4 text-sm text-muted-foreground">No output observed yet.</div>}
    </div>
  );
}

function propertyLabel(name: string, property: SchemaProperty): string {
  return typeof property.title === 'string' ? property.title : name;
}

function schemaChoices(property: SchemaProperty, key: 'enum' | 'oneOf' | 'anyOf'): Array<{ value: string; label: string }> {
  const source = property[key];
  if (!Array.isArray(source)) return [];
  return source.flatMap((entry) => {
    if (typeof entry === 'string') return [{ value: entry, label: entry }];
    if (!entry || typeof entry !== 'object') return [];
    const option = entry as Record<string, unknown>;
    return typeof option.const === 'string'
      ? [{ value: option.const, label: typeof option.title === 'string' ? option.title : option.const }]
      : [];
  });
}

function FreeTextArrayField({ label, selected, onChange }: { label: string; selected: string[]; onChange: (value: FormValue | undefined) => void }) {
  const [draft, setDraft] = useState(() => selected.join(', '));
  return <label className="block text-sm"><span className="mb-1 block text-muted-foreground">{label}</span><Input aria-label={label} value={draft} onChange={(event) => {
    const next = event.target.value;
    setDraft(next);
    onChange(next.split(',').map((item) => item.trim()).filter(Boolean));
  }} /></label>;
}

function FormField({ name, property, value, onChange }: { name: string; property: SchemaProperty; value: FormValue | undefined; onChange: (value: FormValue | undefined) => void }) {
  const label = propertyLabel(name, property);
  const options = schemaChoices(property, 'enum').concat(schemaChoices(property, 'oneOf'));
  if (property.type === 'boolean') {
    return <label className="flex items-center gap-2 text-sm"><input aria-label={label} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
  }
  if (options.length > 0) {
    return <label className="block text-sm"><span className="mb-1 block text-muted-foreground">{label}</span><select aria-label={label} className={selectClass} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value || undefined)}><option value="">Select…</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
  }
  if (property.type === 'number' || property.type === 'integer') {
    return <label className="block text-sm"><span className="mb-1 block text-muted-foreground">{label}</span><Input aria-label={label} type="number" step={property.type === 'integer' ? 1 : 'any'} min={typeof property.minimum === 'number' ? property.minimum : undefined} max={typeof property.maximum === 'number' ? property.maximum : undefined} value={typeof value === 'number' ? value : ''} onChange={(event) => onChange(event.target.value === '' || Number.isNaN(event.target.valueAsNumber) ? undefined : event.target.valueAsNumber)} /></label>;
  }
  if (property.type === 'array') {
    const items = schemaProperty(property.items) ?? {};
    const itemOptions = schemaChoices(items, 'enum').concat(schemaChoices(items, 'anyOf'));
    const selected = Array.isArray(value) ? value : [];
    if (itemOptions.length > 0) {
      return <fieldset className="space-y-1 text-sm"><legend className="mb-1 text-muted-foreground">{label}</legend>{itemOptions.map((option) => <label key={option.value} className="flex items-center gap-2"><input type="checkbox" checked={selected.includes(option.value)} onChange={(event) => onChange(event.target.checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))} />{option.label}</label>)}</fieldset>;
    }
    return <FreeTextArrayField label={label} selected={selected} onChange={onChange} />;
  }
  return <label className="block text-sm"><span className="mb-1 block text-muted-foreground">{label}</span><Input aria-label={label} type={property.format === 'date' ? 'date' : property.format === 'date-time' ? 'datetime-local' : 'text'} minLength={typeof property.minLength === 'number' ? property.minLength : undefined} maxLength={typeof property.maxLength === 'number' ? property.maxLength : undefined} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value || undefined)} /></label>;
}

function validateForm(schema: Record<string, unknown>, values: Record<string, FormValue>): string | null {
  if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) return 'This request cannot be answered with a structured response.';
  const properties = schema.properties as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
  for (const key of required) {
    const property = schemaProperty(properties[key]) ?? {};
    if (!(key in values) || values[key] === '' || (Array.isArray(values[key]) && values[key].length === 0)) return `${propertyLabel(key, property)} is required.`;
  }
  for (const [key, value] of Object.entries(values)) {
    const property = schemaProperty(properties[key]);
    if (!property) return 'The response contains an unsupported field.';
    if (property.type === 'string') {
      if (typeof value !== 'string') return `${propertyLabel(key, property)} is invalid.`;
      if (typeof property.minLength === 'number' && value.length < property.minLength) return `${propertyLabel(key, property)} is too short.`;
      if (typeof property.maxLength === 'number' && value.length > property.maxLength) return `${propertyLabel(key, property)} is too long.`;
      if (Array.isArray(property.enum) && !property.enum.includes(value)) return `${propertyLabel(key, property)} is invalid.`;
      if (schemaChoices(property, 'oneOf').length > 0 && !schemaChoices(property, 'oneOf').some((option) => option.value === value)) return `${propertyLabel(key, property)} is invalid.`;
      if (typeof property.pattern === 'string') {
        try {
          if (!new RegExp(property.pattern, 'u').test(value)) return `${propertyLabel(key, property)} is invalid.`;
        } catch {
          return `${propertyLabel(key, property)} is invalid.`;
        }
      }
      if (property.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) return `${propertyLabel(key, property)} is not a valid email address.`;
      if (property.format === 'uri') {
        try {
          new URL(value);
        } catch {
          return `${propertyLabel(key, property)} is not a valid URL.`;
        }
      }
      if (property.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return `${propertyLabel(key, property)} is not a valid date.`;
      if (property.format === 'date-time' && Number.isNaN(Date.parse(value))) return `${propertyLabel(key, property)} is not a valid date and time.`;
    } else if (property.type === 'number' || property.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (property.type === 'integer' && !Number.isSafeInteger(value))) return `${propertyLabel(key, property)} is invalid.`;
      if (typeof property.minimum === 'number' && value < property.minimum) return `${propertyLabel(key, property)} is below the minimum.`;
      if (typeof property.maximum === 'number' && value > property.maximum) return `${propertyLabel(key, property)} is above the maximum.`;
    } else if (property.type === 'boolean' && typeof value !== 'boolean') return `${propertyLabel(key, property)} is invalid.`;
    else if (property.type === 'array') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return `${propertyLabel(key, property)} is invalid.`;
      if (typeof property.minItems === 'number' && value.length < property.minItems) return `${propertyLabel(key, property)} needs more selections.`;
      if (typeof property.maxItems === 'number' && value.length > property.maxItems) return `${propertyLabel(key, property)} has too many selections.`;
      const items = schemaProperty(property.items) ?? {};
      const choices = Array.isArray(items.enum) ? items.enum : Array.isArray(items.anyOf) ? items.anyOf.map((item) => schemaProperty(item)?.const) : [];
      if (choices.length > 0 && value.some((item) => !choices.includes(item))) return `${propertyLabel(key, property)} is invalid.`;
    } else if (property.type !== 'boolean') return `${propertyLabel(key, property)} is invalid.`;
  }
  return null;
}

function RequestCard({ request, active, submit }: { request: ClaimExecutionRequest; active: boolean; submit: (request: ClaimExecutionRequest, answer: Record<string, unknown>) => Promise<void> }) {
  const payload = request.payload && typeof request.payload === 'object' ? request.payload as Record<string, unknown> : {};
  const schema = schemaProperty(payload.requestedSchema) ?? {};
  const properties = schemaProperty(schema.properties) ?? {};
  const [values, setValues] = useState<Record<string, FormValue>>(() => {
    const initial: Record<string, FormValue> = {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && schemaProperty(properties[key])?.type === 'boolean') initial[key] = false;
    }
    return initial;
  });
  const [error, setError] = useState<string | null>(null);
  if (request.status !== 'open') {
    const labels = { answer_queued: 'Answer sent, waiting for the agent server', resolved: 'Resolved', uncertain: 'Delivery could not be confirmed', cancelled: 'Cancelled' };
    return <div className="rounded-md border border-border p-3 text-sm"><strong>{typeof payload.title === 'string' ? payload.title : typeof payload.message === 'string' ? payload.message : 'Request'}</strong><p className="mt-1 text-muted-foreground">{labels[request.status]}</p></div>;
  }
  if (request.kind === 'permission') {
    const options = Array.isArray(payload.options) ? payload.options.filter((option): option is Record<string, unknown> => Boolean(option && typeof option === 'object')) : [];
    const subject = payload.subject && typeof payload.subject === 'object' ? payload.subject as Record<string, unknown> : null;
    return (
      <div className="rounded-md border border-orange-500/40 bg-orange-500/10 p-3 text-sm">
        <strong>{typeof payload.title === 'string' ? payload.title : 'Permission required'}</strong>
        {typeof payload.description === 'string' && <p className="mt-1 text-muted-foreground">{payload.description}</p>}
        {subject?.type === 'command' && <div className="mt-2 whitespace-pre-wrap break-words font-mono text-xs">{String(subject.command ?? '')}</div>}
        <div className="mt-3 flex flex-wrap gap-2">{options.map((option) => <Button key={String(option.optionId)} size="sm" variant={typeof option.kind === 'string' && option.kind.startsWith('allow_') ? 'default' : 'outline'} disabled={!active} onClick={() => void submit(request, { outcome: { outcome: 'selected', optionId: option.optionId } })}>{String(option.name ?? option.optionId)}</Button>)}<Button size="sm" variant="outline" disabled={!active} onClick={() => void submit(request, { outcome: { outcome: 'cancelled' } })}>Dismiss</Button></div>
      </div>
    );
  }
  const mode = typeof payload.mode === 'string' ? payload.mode : 'unknown';
  const setValue = (name: string, value: FormValue | undefined) => {
    setValues((current) => {
      if (value !== undefined) return { ...current, [name]: value };
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  };
  const accept = () => {
    const invalid = validateForm(schema, values);
    setError(invalid);
    if (!invalid) void submit(request, { action: 'accept', content: values });
  };
  return (
    <div className="rounded-md border border-orange-500/40 bg-orange-500/10 p-3 text-sm">
      <strong>{typeof payload.message === 'string' ? payload.message : 'Input required'}</strong>
      {mode === 'url' && typeof payload.url === 'string' && <p className="mt-2 break-all font-mono text-xs">{payload.url}</p>}
      {mode === 'form' && <div className="mt-3 space-y-3">{Object.entries(properties).map(([name, property]) => {
        const validProperty = schemaProperty(property);
        return validProperty ? <FormField key={name} name={name} property={validProperty} value={values[name]} onChange={(value) => setValue(name, value)} /> : null;
      })}</div>}
      {error && <div role="alert" className="mt-2 text-destructive">{error}</div>}
      <div className="mt-3 flex flex-wrap gap-2">{(mode === 'form' || mode === 'url') && <Button size="sm" disabled={!active} onClick={mode === 'form' ? accept : () => void submit(request, { action: 'accept' })}>Accept response</Button>}<Button size="sm" variant="outline" disabled={!active} onClick={() => void submit(request, { action: 'decline' })}>Decline</Button><Button size="sm" variant="outline" disabled={!active} onClick={() => void submit(request, { action: 'cancel' })}>Cancel</Button></div>
    </div>
  );
}

function QueueDeadline({deadline}:{deadline:string}) {
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const remaining=Math.max(0,Math.ceil((Date.parse(deadline)-now)/1000));
  return <span> · {Number.isFinite(remaining)&&remaining>0?`${remaining} seconds remaining`:'Refreshing queue status…'}</span>;
}

type PanelProps = { detail: TaskDetail; reload: () => Promise<void>; selectedClaimId?: number; onBack?: () => void };
export function TaskClaimExecutionTab(props: PanelProps) {
  const { me } = useMe();
  const caps = (props.detail.capabilities ?? []).filter(cap => capabilitiesFor(me, props.detail.projectId).includes(cap));
  const scope = `${props.detail.id}:${props.selectedClaimId}:${me?.principal.id}:${me?.principal.sessionVersion}:${caps.join(',')}`;
  return <ClaimExecutionPanel key={scope} {...props} />;
}
function ClaimExecutionPanel({ detail, reload, selectedClaimId, onBack }: PanelProps) {
  const { me } = useMe();
  const projectCapabilities = capabilitiesFor(me, detail.projectId);
  const allowed = useCallback((capability: string) => (detail.capabilities?.includes(capability) ?? false) && projectCapabilities.includes(capability), [detail, projectCapabilities]);
  const internalRead = allowed('internal.read');
  const canStart = selectedClaimId === undefined && detail.status === 'ready' && allowed('run.start');
  const canSteer = internalRead && allowed('run.steer');
  const canCancel = internalRead && allowed('run.cancel');

  const [claims, setClaims] = useState<ClaimExecutionBadge[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<ClaimExecution | ClaimExecutionBadge | null>(null);
  const [eventState, setEventState] = useState(createClaimEventState);
  const [requests, setRequests] = useState<ClaimExecutionRequest[]>([]);
  const [promptHistory,setPromptHistory]=useState<PromptHistory[]>([]);
  const historyRequest=useRef(new LatestRequest());
  const [historyTruncated,setHistoryTruncated]=useState(false);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [catchingUp, setCatchingUp] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [startOpen, setStartOpen] = useState(false);
  const [startDraft, setStartDraft] = useState({ claimType: 'spec', repo: '', prNumber: '', branch: '', instructions: '' });
  const [startError, setStartError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const commandBusy = useRef(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [receiptCommandId, setReceiptCommandId] = useState<number | null>(null);
  useEffect(() => {
    if (!internalRead || selectedId === null || receiptCommandId === null || !inline) return;
    let stopped = false;
    const stop = pollResource(async signal => {
      try {
        const result = await collabFetch<{status:string}>(`/claim-executions/${selectedId}/commands/${receiptCommandId}`, {signal});
        if (stopped || signal?.aborted) return;
        const labels:Record<string,string> = {pending:'Queued — waiting for agent acceptance.',delivered:'Delivered — waiting for agent acceptance.',acked:'Accepted by agent.',failed:'The agent rejected this command.',uncertain:'Delivery is uncertain. It will not be replayed automatically.',cancelled:'Command cancelled.'};
        setReceipt(labels[result.data.status] ?? 'Command status unavailable.');
        if (['acked','failed','uncertain','cancelled'].includes(result.data.status)) setReceiptCommandId(null);
      } catch(error) {
        if (stopped || signal?.aborted) return;
        if (isDenied(error)) clearPrivate();
        else setReceipt('Command status is temporarily unavailable. Do not resend an uncertain prompt.');
      }
    }, 1000);
    return () => {stopped=true;stop();};
  }, [internalRead, selectedId, receiptCommandId]);
  const [following, setFollowing] = useState(true);
  const postedReadSeq = useRef(0);
  const output = useRef<HTMLDivElement>(null);
  const endIntent = useRef(newKey());
  const inline = selectedClaimId !== undefined;
  useEffect(() => { if (following && output.current) output.current.scrollTop = output.current.scrollHeight; }, [following, eventState.lastSeq, promptHistory.length]);
  useEffect(() => () => { selectedIdRef.current = null; }, []);
  const [, setAnsweringVersion] = useState(0);

  const listRequest = useRef(new LatestRequest());
  const detailRequest = useRef(new LatestRequest());
  const eventRequest = useRef(new LatestRequest());
  const requestRequest = useRef(new LatestRequest());
  const eventCursor = useRef('');
  const selectedIdRef = useRef<number | null>(null);
  const promptKey = useRef(newKey());
  const startKey = useRef(newKey());
  const cancelIntent = useRef({ claimId: null as number | null, key: newKey() });
  const answerIntents = useRef(new Map<string, { body: string; key: string }>());
  const answerInFlight = useRef(new Map<string, string>());
  const deniedRef = useRef(false);
  const accessSignature = `${internalRead}:${canStart}:${canSteer}:${canCancel}`;
  const accessSignatureRef = useRef(accessSignature);
  const changeSelection = useCallback((claimId: number | null) => {
    selectedIdRef.current = claimId;
    detailRequest.current.dispose();
    eventRequest.current.dispose();
    requestRequest.current.dispose();
    setSelected(null);
    setEventState(createClaimEventState());
    setRequests([]);
    setPromptHistory([]);
    historyRequest.current.dispose();
    setPrompt('');
    setCommandError(null);
    setSubmitting(false);
    setCatchingUp(false);
    setLiveError(false);
    promptKey.current = newKey();
    cancelIntent.current = { claimId, key: newKey() };
    answerIntents.current.clear();
    answerInFlight.current.clear();
    setAnsweringVersion((current) => current + 1);
    eventCursor.current = '';
    postedReadSeq.current = 0;
    setSelectedId(claimId);
  }, []);


  const clearPrivate = useCallback(() => {
    selectedIdRef.current = null;
    setClaims([]);
    setSelectedId(null);
    setSelected(null);
    setEventState(createClaimEventState());
    setRequests([]);
    setPromptHistory([]);
    historyRequest.current.dispose();
    setPrompt('');
    setStartDraft({ claimType: 'spec', repo: '', prNumber: '', branch: '', instructions: '' });
    setStartOpen(false);
    setStartError(null);
    setCommandError(null);
    setSubmitting(false);
    promptKey.current = newKey();
    cancelIntent.current = { claimId: null, key: newKey() };
    answerIntents.current.clear();
    answerInFlight.current.clear();
    setAnsweringVersion((current) => current + 1);
    eventCursor.current = '';
    postedReadSeq.current = 0;
    deniedRef.current = true;
    setDenied(true);
  }, []);

  const handleReadError = useCallback((error: unknown) => {
    if (isDenied(error)) {
      clearPrivate();
      return true;
    }
    return false;
  }, [clearPrivate]);

  const [readTick, setReadTick] = useState(0);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') setReadTick((tick) => tick + 1);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    if (!internalRead || selectedId === null || !following || eventState.renderedSeq <= 0) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const seq = eventState.renderedSeq;
    const claimId = selectedId;
    if (postedReadSeq.current >= seq) return;
    void (async () => {
      try {
        const result = await markClaimRead(claimId, seq);
        if (selectedIdRef.current === claimId) postedReadSeq.current = Math.max(postedReadSeq.current, result.lastSeq);
      } catch (error) {
        if (selectedIdRef.current !== claimId) return;
        if (isDenied(error)) { clearPrivate(); return; }
        postedReadSeq.current = 0;
      }
    })();
  }, [internalRead, selectedId, following, eventState.renderedSeq, readTick, clearPrivate]);

  const loadClaims = useCallback(async (parent?: AbortSignal) => {
    const signal = listRequest.current.begin(parent);
    try {
      const collected: ClaimExecutionBadge[] = [];
      let cursor = '';
      let page = 0;
      do {
        const path = pagePath(`/tasks/${detail.id}/claim-executions?limit=50`, cursor);
        const result = await collabFetch<ClaimExecutionBadge[]>(path, { signal });
        collected.push(...result.data);
        cursor = result.nextCursor ?? '';
        page += 1;
      } while (cursor && page < MAX_PAGES);
      if (!listRequest.current.current(signal) || deniedRef.current) return;
      setClaims(collected);
      const currentId = selectedIdRef.current;
      const requested = selectedClaimId ?? currentId;
      const nextId = requested !== null && collected.some(claim => claim.id === requested) ? requested : selectedClaimId === undefined ? collected.at(-1)?.id ?? null : null;
      if (nextId !== currentId) changeSelection(nextId);
      setListError(null);
      setDenied(false);
    } catch (error) {
      if (!listRequest.current.current(signal)) return;
      if (!handleReadError(error)) setListError('Executions are temporarily unavailable.');
    } finally {
      if (listRequest.current.current(signal)) setLoading(false);
    }
  }, [detail.id, handleReadError, changeSelection, selectedClaimId]);

  const loadDetail = useCallback(async (parent?: AbortSignal) => {
    if (selectedId === null || !internalRead || deniedRef.current) return;
    const signal = detailRequest.current.begin(parent);
    try {
      const result = await collabFetch<ClaimExecution | ClaimExecutionBadge>(`/claim-executions/${selectedId}`, { signal });
      if (detailRequest.current.current(signal)) setSelected(result.data);
    } catch (error) {
      if (detailRequest.current.current(signal)) handleReadError(error);
    }
  }, [selectedId, internalRead, handleReadError]);

  const loadEvents = useCallback(async (parent?: AbortSignal) => {
    if (selectedId === null || !internalRead || deniedRef.current) return;
    const signal = eventRequest.current.begin(parent);
    try {
      const collected: ClaimExecutionEvent[] = [];
      let cursor = eventCursor.current;
      let page = 0;
      let next = '';
      do {
        const result = await collabFetch<ClaimExecutionEvent[]>(pagePath(`/claim-executions/${selectedId}/events?limit=100`, cursor), { signal });
        collected.push(...result.data);
        next = result.nextCursor ?? '';
        if (next) cursor = next;
        else if (result.data.length > 0) cursor = cursorAfter(result.data[result.data.length - 1].seq);
        page += 1;
      } while (next && page < MAX_PAGES);
      if (!eventRequest.current.current(signal)) return;
      eventCursor.current = cursor;
      setEventState((current) => reduceClaimEvents(current, collected));
      setCatchingUp(Boolean(next));
      setLiveError(false);
    } catch (error) {
      if (!eventRequest.current.current(signal)) return;
      if (!handleReadError(error)) setLiveError(true);
    }
  }, [selectedId, internalRead, handleReadError]);

  const loadPrompts = useCallback(async(parent?:AbortSignal)=>{
    if(selectedId===null||!internalRead||deniedRef.current||!inline)return;
    const signal=historyRequest.current.begin(parent);
    try{const result=await collabFetchAll<PromptHistory>(`/claim-executions/${selectedId}/prompts?limit=100`,{signal});
      if(historyRequest.current.current(signal)){setPromptHistory(result.data);setHistoryTruncated(result.truncated);}
    }catch(error){if(!historyRequest.current.current(signal))return;if(!handleReadError(error))setLiveError(true);}
  },[selectedId,internalRead,handleReadError,inline]);

  const loadRequests = useCallback(async (parent?: AbortSignal) => {
    if (selectedId === null || !internalRead || deniedRef.current) return;
    const signal = requestRequest.current.begin(parent);
    try {
      const collected: ClaimExecutionRequest[] = [];
      let cursor = '';
      let page = 0;
      do {
        const result = await collabFetch<ClaimExecutionRequest[]>(pagePath(`/claim-executions/${selectedId}/requests?limit=100`, cursor), { signal });
        collected.push(...result.data);
        cursor = result.nextCursor ?? '';
        page += 1;
      } while (cursor && page < MAX_PAGES);
      if (!requestRequest.current.current(signal)) return;
      setRequests(collected);
    } catch (error) {
      if (requestRequest.current.current(signal)) handleReadError(error);
    }
  }, [selectedId, internalRead, handleReadError]);

  useEffect(() => {
    if (accessSignatureRef.current === accessSignature) return;
    accessSignatureRef.current = accessSignature;
    deniedRef.current = false;
    setDenied(false);
  }, [accessSignature]);

  useEffect(() => {
    deniedRef.current = false;
    selectedIdRef.current = null;
    setClaims([]);
    setSelectedId(null);
    setSelected(null);
    setEventState(createClaimEventState());
    setRequests([]);
    setPromptHistory([]);
    historyRequest.current.dispose();
    setLoading(true);
    setDenied(false);
    setListError(null);
    setPrompt('');
    setCommandError(null);
    setSubmitting(false);
    promptKey.current = newKey();
    cancelIntent.current = { claimId: null, key: newKey() };
    answerIntents.current.clear();
    answerInFlight.current.clear();
    setAnsweringVersion((current) => current + 1);
    eventCursor.current = '';
    const stop = pollResource(loadClaims);
    return () => { stop(); listRequest.current.dispose(); };
  }, [detail.id, loadClaims]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    setSelected(null);
    setEventState(createClaimEventState());
    setRequests([]);
    setPromptHistory([]);
    historyRequest.current.dispose();
    setPrompt('');
    setCommandError(null);
    setSubmitting(false);
    setCatchingUp(false);
    setLiveError(false);
    promptKey.current = newKey();
    cancelIntent.current = { claimId: selectedId, key: newKey() };
    answerIntents.current.clear();
    answerInFlight.current.clear();
    setAnsweringVersion((current) => current + 1);
    eventCursor.current = '';
    postedReadSeq.current = 0;
    if (selectedId === null) return;
    const stopDetail = pollResource(loadDetail, inline ? 1000 : 3000);
    const stopEvents = pollResource(loadEvents, inline ? 1000 : 3000);
    const stopRequests = pollResource(loadRequests, inline ? 1000 : 3000);
    const stopPrompts = pollResource(loadPrompts, 1000);
    return () => {
      stopDetail();
      stopEvents();
      stopRequests();
      stopPrompts();
      historyRequest.current.dispose();
      detailRequest.current.dispose();
      eventRequest.current.dispose();
      requestRequest.current.dispose();
    };
  }, [selectedId, loadDetail, loadEvents, loadRequests, loadPrompts]);

  useEffect(() => {
    if (canSteer) return;
    setPrompt('');
    setCommandError(null);
    promptKey.current = newKey();
  }, [canSteer]);

  const selectedBadge = claims.find((claim) => claim.id === selectedId) ?? selected;
  const active = selectedBadge?.status === 'claimed';
  const commandPath = selectedId === null ? '' : `/claim-executions/${selectedId}/commands`;

  const sendPrompt = async () => {
    const draft = prompt;
    const text = draft.trim();
    const claimId = selectedId;
    const key = promptKey.current;
    if (!text || !active || claimId === null || !canSteer || commandBusy.current) return;
    commandBusy.current = true;
    setSubmitting(true);
    setCommandError(null);
    try {
      const result = await collabFetch<SubmitClaimCommandResult>(commandPath, { method: 'POST', idempotencyKey: key, body: { kind: 'prompt', payload: { text } } });
      if (selectedIdRef.current === claimId && promptKey.current === key) {
        setReceiptCommandId(result.data.commandId);
        setPrompt('');
        setReceipt('Queued — waiting for agent acceptance.');
        promptKey.current = newKey();
      }
    } catch (error) {
      if (selectedIdRef.current !== claimId) return;
      if (error instanceof ApiError && error.code === 'idempotency_conflict' && promptKey.current === key) promptKey.current = newKey();
      setCommandError(error instanceof ApiError && error.code === 'claim_not_active' ? 'This execution is no longer active.' : 'Prompt could not be sent. Try again.');
    } finally {
      commandBusy.current = false;
      if (selectedIdRef.current === claimId) setSubmitting(false);
    }
  };

  const cancel = async (kind: 'cancel' | 'end_session' = 'cancel') => {
    setReceiptCommandId(null);
    const claimId = selectedId;
    if (claimId === null || !canCancel || commandBusy.current || !selectedBadge || !['pending', 'claimed'].includes(selectedBadge.status)) return;
    commandBusy.current = true;
    if (cancelIntent.current.claimId !== claimId) cancelIntent.current = { claimId, key: newKey() };
    const key = kind === 'end_session' ? endIntent.current : cancelIntent.current.key;
    setSubmitting(true);
    setCommandError(null);
    try {
      await collabFetch<SubmitClaimCommandResult>(commandPath, { method: 'POST', idempotencyKey: key, body: { kind, payload: {} } });
      if (selectedIdRef.current !== claimId) return;
      cancelIntent.current = { claimId, key: newKey() };
      if (kind === 'end_session') endIntent.current = newKey();
      setReceipt(kind === 'end_session' ? 'End requested — waiting for session closure.' : 'Stop requested — the session remains open.');
      await loadClaims();
    } catch (error) {
      if (selectedIdRef.current !== claimId) return;
      if (error instanceof ApiError && error.code === 'idempotency_conflict') cancelIntent.current = { claimId, key: newKey() };
      setCommandError(error instanceof ApiError && error.code === 'claim_not_active' ? 'This execution is no longer active.' : 'Cancellation could not be sent. Try again.');
    } finally {
      commandBusy.current = false;
      if (selectedIdRef.current === claimId) setSubmitting(false);
    }
  };

  const submitAnswer = async (request: ClaimExecutionRequest, answer: Record<string, unknown>) => {
    const claimId = selectedId;
    if (claimId === null || answerInFlight.current.has(request.requestKey)) return;
    const body = { kind: request.kind, requestKey: request.requestKey, payload: { answer } };
    const bodyKey = deterministicJson(body);
    let intent = answerIntents.current.get(request.requestKey);
    if (!intent || intent.body !== bodyKey) {
      intent = { body: bodyKey, key: newKey() };
      answerIntents.current.set(request.requestKey, intent);
    }
    const key = intent.key;
    answerInFlight.current.set(request.requestKey, key);
    setAnsweringVersion((current) => current + 1);
    setCommandError(null);
    try {
      await collabFetch<SubmitClaimCommandResult>(commandPath, {
        method: 'POST',
        idempotencyKey: key,
        body,
      });
      if (selectedIdRef.current === claimId) {
        answerIntents.current.delete(request.requestKey);
        await loadRequests();
      }
    } catch (error) {
      if (selectedIdRef.current !== claimId) return;
      if (error instanceof ApiError && error.code === 'idempotency_conflict') {
        answerIntents.current.set(request.requestKey, { body: bodyKey, key: newKey() });
      }
      if (error instanceof ApiError && error.code === 'request_conflict') {
        setCommandError('This request is no longer available.');
        await loadRequests();
      } else if (error instanceof ApiError && error.code === 'claim_not_active') {
        setCommandError('This execution is no longer active.');
      } else {
        setCommandError('The response could not be sent. Try again.');
      }
    } finally {
      if (answerInFlight.current.get(request.requestKey) === key) answerInFlight.current.delete(request.requestKey);
      if (selectedIdRef.current === claimId) setAnsweringVersion((current) => current + 1);
    }
  };

  const startExecution = async () => {
    const repo = startDraft.repo.trim();
    const branch = startDraft.branch.trim();
    const instructions = startDraft.instructions.trim();
    const parsedPr = startDraft.prNumber === '' ? null : Number(startDraft.prNumber);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.length > 200) {
      setStartError('Enter a repository as owner/name.');
      return;
    }
    if (parsedPr !== null && (!Number.isInteger(parsedPr) || parsedPr <= 0)) {
      setStartError('Pull request must be a positive number.');
      return;
    }
    if (branch.length > 500 || instructions.length > 20000) {
      setStartError('The execution details are too long.');
      return;
    }
    setSubmitting(true);
    setStartError(null);
    try {
      await collabFetch<StartClaimExecutionResult>(`/tasks/${detail.id}/claim-executions`, {
        method: 'POST',
        idempotencyKey: startKey.current,
        body: {
          expectedVersion: detail.version,
          repo,
          claimType: startDraft.claimType,
          prNumber: parsedPr,
          branch: branch || null,
          ...(instructions ? { instructions } : {}),
        },
      });
      setStartDraft({ claimType: 'spec', repo: '', prNumber: '', branch: '', instructions: '' });
      setStartOpen(false);
      startKey.current = newKey();
      await loadClaims();
      await reload();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'version_conflict') {
        setStartError('This item changed. Refresh before saving.');
        await reload();
      } else {
        if (error instanceof ApiError && error.code === 'idempotency_conflict') startKey.current = newKey();
        setStartError('Could not start execution. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };
  const selectClaim = (claimId: number) => {
    if (claimId !== selectedId) changeSelection(claimId);
  };


  const detailPayload = selected && 'payload' in selected ? selected.payload : null;
  const visibleRequests = useMemo(() => requests, [requests]);

  if (denied) return <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">Execution access is no longer available.</div>;

  return (
    <div className={inline ? 'flex h-full min-h-0 flex-col' : 'space-y-4'}>
      {inline && <div className="border-b border-border p-5"><Button variant="ghost" size="sm" onClick={onBack}>Back to task</Button><h2 className="mt-3 text-sm font-medium">{detail.title} · {selectedBadge?.claimType === 'chat' ? 'Agent session' : 'Execution'} {selectedId}</h2></div>}
      {inline && !loading && !selectedBadge && <p role="alert" className="p-5">This session is not available on this task.</p>}
      {canStart && <div className="flex justify-end"><Button size="sm" onClick={() => setStartOpen((open) => !open)}>{startOpen ? 'Close start form' : 'Start execution'}</Button></div>}
      {startOpen && <section aria-label="Start execution" className="rounded-lg border border-border bg-card p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="text-sm"><span className="mb-1 block text-muted-foreground">Phase</span><select aria-label="Phase" className={selectClass} value={startDraft.claimType} onChange={(event) => setStartDraft((draft) => ({ ...draft, claimType: event.target.value }))}><option value="spec">Spec</option><option value="build">Build</option></select></label>
          <label className="text-sm"><span className="mb-1 block text-muted-foreground">Repository</span><Input aria-label="Repository" placeholder="owner/name" value={startDraft.repo} onChange={(event) => setStartDraft((draft) => ({ ...draft, repo: event.target.value }))} /></label>
          <label className="text-sm"><span className="mb-1 block text-muted-foreground">Pull request</span><Input aria-label="Pull request" inputMode="numeric" value={startDraft.prNumber} onChange={(event) => setStartDraft((draft) => ({ ...draft, prNumber: event.target.value }))} /></label>
          <label className="text-sm"><span className="mb-1 block text-muted-foreground">Branch</span><Input aria-label="Branch" maxLength={500} value={startDraft.branch} onChange={(event) => setStartDraft((draft) => ({ ...draft, branch: event.target.value }))} /></label>
        </div>
        <label className="mt-3 block text-sm"><span className="mb-1 block text-muted-foreground">Instructions</span><textarea aria-label="Instructions" maxLength={20000} className={textareaClass} value={startDraft.instructions} onChange={(event) => setStartDraft((draft) => ({ ...draft, instructions: event.target.value }))} /></label>
        {startError && <div role="alert" className="mt-3 text-sm text-destructive">{startError}</div>}
        <div className="mt-3"><Button size="sm" disabled={submitting} onClick={() => void startExecution()}>Start</Button></div>
      </section>}

      {listError && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">{listError}</div>}
      <div className={inline ? "flex min-h-0 flex-1 flex-col" : "grid grid-cols-1 gap-4 lg:grid-cols-3"}>
        {!inline && <section aria-label="Claims" className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-3 text-sm font-semibold">Claim executions</h3>
          {loading && <div role="status" className="space-y-2"><span className="sr-only">Loading executions</span><div className="h-14 animate-pulse rounded-md bg-secondary" /><div className="h-14 animate-pulse rounded-md bg-secondary" /></div>}
          {!loading && claims.length === 0 && !listError && <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">No claim executions yet. Start an execution when the task is ready.</div>}
          <div className="space-y-2">{claims.map((claim) => <button key={claim.id} type="button" aria-pressed={selectedId === claim.id} onClick={() => selectClaim(claim.id)} className={`w-full rounded-md border p-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${selectedId === claim.id ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-accent/40'}`}><div className="flex items-center justify-between gap-2"><span className="font-medium">{claim.claimType} · attempt {claim.attempt}</span><span className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium">{statusLabel(claim.status)}</span></div><div className="mt-1 text-xs text-muted-foreground">{new Date(claim.createdAt).toLocaleString()}</div></button>)}</div>
        </section>}

        <section aria-label="Execution detail" className={inline ? "flex min-h-0 flex-1 flex-col" : "space-y-4 lg:col-span-2"}>
          {selectedBadge && <div className={inline ? "shrink-0 border-b border-border px-5 py-3" : "rounded-lg border border-border bg-card p-4"}>
            <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-medium">{inline && selectedBadge.claimType === 'chat' ? `Agent session ${selectedBadge.id}` : `${selectedBadge.claimType} · attempt ${selectedBadge.attempt}`}</h3><div className="flex gap-2"><span data-claim-status className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium">{inline && selectedBadge.claimType === 'chat' && selectedBadge.status === 'claimed' ? 'Open' : statusLabel(selectedBadge.status)}</span>{eventState.runnerState && <span data-runner-state className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium">{runnerLabel(eventState.runnerState.state)}</span>}</div></div>
            {!inline && selected && 'repo' in selected && <div className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2"><div className="min-w-0 break-words"><span className="text-muted-foreground">Repository </span>{selected.repo}</div>{selected.prNumber !== null && <div><span className="text-muted-foreground">Pull request </span>{selected.prNumber}</div>}{detailPayload && typeof detailPayload.branch === 'string' && <div className="min-w-0 break-words"><span className="text-muted-foreground">Branch </span>{detailPayload.branch}</div>}{detailPayload && typeof detailPayload.instructions === 'string' && <div className="min-w-0 whitespace-pre-wrap break-words sm:col-span-2"><span className="text-muted-foreground">Instructions </span>{detailPayload.instructions}</div>}</div>}
            {selectedBadge.status === 'pending' && <p role="status" className="mt-3 text-sm text-muted-foreground">Waiting for a free slot{selected && 'pendingDeadlineAt' in selected && selected.pendingDeadlineAt ? <QueueDeadline deadline={selected.pendingDeadlineAt}/> : ''}.</p>}
            {selectedBadge.endReason && <p className="mt-3 text-sm text-muted-foreground">Session ended · {selectedBadge.endReason.replaceAll('_', ' ')}. New sessions start with fresh context.</p>}
            {canCancel && ['pending', 'claimed'].includes(selectedBadge.status) && <div className="mt-3 flex gap-2">{(selectedBadge.claimType !== 'chat' || selectedBadge.status === 'claimed') && <Button variant="outline" size="sm" disabled={submitting} onClick={() => void cancel()}>{selectedBadge.claimType === 'chat' ? 'Stop response' : 'Cancel execution'}</Button>}{selectedBadge.claimType === 'chat' && <Button variant="outline" size="sm" disabled={submitting} onClick={() => void cancel('end_session')}>End session</Button>}</div>}
            {internalRead && canSteer && allowed('run.start') && selectedBadge.claimType === 'chat' && selectedBadge.status === 'claimed' && selected && 'repo' in selected && <ChatHandoffControls key={selectedBadge.id} detail={detail} claimId={selectedBadge.id} repo={selected.repo} canCreateTask={allowed('task.write')} reload={reload}/>}
          </div>}

          {!internalRead && selectedBadge && <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">Internal transcript and controls require operator permissions.</div>}
          {internalRead && selectedBadge && <>
            {liveError && <div role="status" aria-label="Live output" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">Live output is temporarily unavailable. Showing last observed output.</div>}
            {catchingUp && <div aria-live="polite" className="text-xs text-muted-foreground">Catching up with execution output…</div>}
            <div ref={output} onScroll={event => {const node=event.currentTarget;setFollowing(node.scrollHeight-node.scrollTop-node.clientHeight<64);}} className={inline ? 'min-h-0 flex-1 overflow-y-auto p-5 [overflow-wrap:anywhere]' : 'rounded-lg border border-border bg-card p-4'}><h3 className={inline ? "sr-only" : "mb-3 text-sm font-semibold"}>Live output</h3><Timeline state={eventState} compact={inline} prompts={promptHistory}/>{historyTruncated?<p role="status" className="mt-3 text-xs text-muted-foreground">Earlier prompt history exceeds the display limit.</p>:null}
            {visibleRequests.length > 0 && <div className="mt-5 border-t border-border pt-4"><h3 className="mb-3 text-sm font-medium">Requests</h3><div className="space-y-2">{visibleRequests.map((request) => <RequestCard key={request.requestKey} request={request} active={Boolean(active && canSteer && !answerInFlight.current.has(request.requestKey))} submit={submitAnswer} />)}</div></div>}</div>
            {inline && !following && <Button variant="outline" size="sm" className="mx-auto my-2" onClick={()=>{setFollowing(true);if(output.current)output.current.scrollTop=output.current.scrollHeight;}}>Jump to latest</Button>}

            {canSteer && active && <div className={inline ? "flow-root shrink-0 border-t border-border bg-background p-5" : "rounded-lg border border-border bg-card p-4"}><label className="text-sm"><span className="mb-1 block text-muted-foreground">{inline ? `Send to agent · session ${selectedId}` : 'Prompt'}</span><textarea aria-label="Prompt" maxLength={20000} className={textareaClass} value={prompt} onChange={(event) => {
              const next = event.target.value;
              if (next !== prompt) promptKey.current = newKey();
              setPrompt(next);
              setCommandError(null);
            }} /></label><Button className={inline ? "mt-3 float-right" : "mt-3"} size="sm" disabled={submitting || prompt.trim().length === 0} onClick={() => void sendPrompt()}>{inline ? 'Send to agent' : 'Send prompt'}</Button></div>}
            {receipt && <p role="status" className="px-5 pb-3 text-xs text-muted-foreground">{receipt}</p>}
            {commandError && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{commandError}</div>}
          </>}
        </section>
      </div>
    </div>
  );
}
