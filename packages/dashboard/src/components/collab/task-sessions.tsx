'use client';
import {useCallback, useEffect, useRef, useState} from 'react';
import { ArrowUpRight } from 'lucide-react';
import {Button} from '@/components/ui/button';
import {ApiError, collabFetch, collabFetchAll} from '@/lib/collab/api';
import {fetchTaskClaimProgress, type ClaimProgressCard} from '@/lib/collab/claim-progress';
import {LatestRequest, pollResource} from '@/lib/collab/live';
import type {ClaimExecutionBadge, StartClaimExecutionResult} from '@/lib/collab/types';
import type {TaskDetail} from './task-detail';

function isDenied(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

type SessionCard = Pick<ClaimExecutionBadge, 'id' | 'claimType' | 'attempt' | 'status' | 'endReason'>;

function sessionCardTitle(claim: SessionCard, progress: ClaimProgressCard | undefined): string {
  if (claim.claimType !== 'chat') return `${claim.claimType} · attempt ${claim.attempt}`;
  const descriptors = [progress?.profile, progress?.model].filter(Boolean);
  return `Agent session ${claim.id}${descriptors.length ? ` · ${descriptors.join(' · ')}` : ''}`;
}

function sessionCardState(claim: SessionCard, progress: ClaimProgressCard | undefined, canSteer: boolean): string {
  const base = claim.status === 'pending'
    ? 'Waiting for a free slot'
    : claim.claimType === 'chat' && claim.status === 'claimed'
      ? 'Open'
      : claim.status;
  const end = claim.endReason ? ` · ${claim.endReason.replaceAll('_', ' ')}` : '';
  const attention = progress?.needsInput
    ? ` · ${canSteer ? 'Needs your input' : 'Session needs attention'}`
    : progress?.unread ? ' · Unread' : '';
  return `${base}${end}${attention}`;
}

function needsInputLabel(progress: ClaimProgressCard | undefined, canSteer: boolean): string {
  return progress?.needsInput ? (canSteer ? 'Needs your input' : 'Session needs attention') : 'Unread';
}

export function TaskSessions({detail,reload,onSelectClaim,history=false,attendedAvailable=true,repo=null,onProgress}:{detail:TaskDetail;reload:()=>Promise<void>;onSelectClaim:(id:number)=>void;history?:boolean;attendedAvailable?:boolean;repo?:string|null;onProgress?:(claims:ClaimProgressCard[])=>void}) {
 const canSteer=detail.capabilities?.includes('run.steer')??false;
 const [claims,setClaims]=useState<SessionCard[]>([]);
 const [progress,setProgress]=useState<Record<number,ClaimProgressCard>>({});
 const [error,setError]=useState<string|null>(null);
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [truncated,setTruncated]=useState(false);
 const request=useRef(new LatestRequest());
 const denied=useRef(false);
 const intent=useRef<{version:number|null;key:string}>({version:null,key:crypto.randomUUID()});
 const inFlight=useRef(false);
 const alive=useRef(true);
 const load=useCallback(async(parent?:AbortSignal)=>{
  const signal=request.current.begin(parent);
  try { const result=await collabFetchAll<ClaimExecutionBadge>(`/tasks/${detail.id}/claim-executions?limit=50`,{signal});
   if(request.current.current(signal)){setClaims(result.data);setTruncated(result.truncated);setError(null);setLoading(false);}
  } catch(err) { if(request.current.current(signal)){if(isDenied(err)){denied.current=true;setClaims([]);setProgress({});onProgress?.([]);}setError('Sessions are temporarily unavailable.');setLoading(false);} }
  if (denied.current) return;
  try { const cards=await fetchTaskClaimProgress(detail.id,signal);
   if(request.current.current(signal)){
    setProgress(Object.fromEntries(cards.map(c=>[c.claimId,c])));
    setClaims(current=>{
     const ids=new Set(current.map(c=>c.id));
     return [...current,...cards.filter(c=>['pending','claimed'].includes(c.status)&&!ids.has(c.claimId)).map(c=>({id:c.claimId,claimType:c.claimType,attempt:c.attempt,status:c.status,endReason:c.endReason}))];
    });
    onProgress?.(cards);
   }
  } catch(err) {
   if(!request.current.current(signal))return;
   if(isDenied(err)){denied.current=true;setClaims([]);setProgress({});onProgress?.([]);setError('Sessions are temporarily unavailable.');return;}
   setProgress({});onProgress?.([]);setError('Session updates are temporarily unavailable.');
  }
 },[detail.id,onProgress]);
 useEffect(()=>{alive.current=true;const stop=pollResource(async signal=>{await load(signal);if(denied.current)stop();});return()=>{alive.current=false;stop();request.current.dispose();};},[load]);
 async function open(){
  if(inFlight.current||loading)return;
  const existing=claims.find(c=>c.claimType==='chat'&&['pending','claimed'].includes(c.status));
  if(existing){onSelectClaim(existing.id);return;}
  inFlight.current=true;setBusy(true);setError(null);
  intent.current.version ??= detail.version;
  try{
   const result=await collabFetch<StartClaimExecutionResult>(`/tasks/${detail.id}/claim-executions`,{method:'POST',idempotencyKey:intent.current.key,body:{expectedVersion:intent.current.version,claimType:'chat',repo}});
   if(!alive.current)return;
   intent.current={version:null,key:crypto.randomUUID()};onSelectClaim(result.data.claim.id);await reload();
  }catch(err){
   if(!alive.current)return;
   if(err instanceof ApiError&&err.code==='chat_already_open'){await load();setError('A session is already open. Select it below.');}
   else if(err instanceof ApiError&&err.code==='version_conflict')setError('This task changed. Refresh the task before opening a new session.');
   else setError('Could not open the session. Retry preserves this request.');
  }finally{inFlight.current=false;if(alive.current)setBusy(false);}
 }
 return <section aria-label={history?'Run history':'Agent sessions'} className="border-t border-border pt-5">
  {!history?<div className="flex items-center justify-between gap-2"><h2 className="text-sm font-medium">Agent sessions</h2>{attendedAvailable&&detail.capabilities?.includes('internal.read')&&detail.capabilities.includes('run.start')?<Button variant="outline" size="sm" disabled={busy||loading} onClick={()=>void open()}>Open session</Button>:null}</div>:null}
  {error?<p role="alert" className="mt-3 text-sm text-destructive">{error}<Button variant="ghost" size="sm" onClick={()=>{intent.current={version:null,key:crypto.randomUUID()};void reload();void load();}}>Refresh task</Button></p>:null}
  {loading?<p role="status" className="mt-3 text-sm text-muted-foreground">Loading sessions…</p>:null}
  {!loading&&!claims.some(c=>history?c.claimType!=='chat':c.claimType==='chat')?<p className="mt-3 text-sm text-muted-foreground">{history?'No unattended claims yet.':'No attended sessions yet.'}</p>:null}
  <div className="mt-3 space-y-2">{claims.filter(c=>history?c.claimType!=='chat':c.claimType==='chat').map(c=><button key={c.id} onClick={()=>onSelectClaim(c.id)} className="w-full rounded-md border border-border bg-card p-3 text-left hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"><div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{sessionCardTitle(c,progress[c.id])}</span><span className="flex items-center gap-1.5">{progress[c.id]?.needsInput||progress[c.id]?.unread?<span className={progress[c.id]?.needsInput?'rounded border border-orange-500/40 bg-orange-500/10 px-1.5 py-0.5 text-[11px] font-medium':'rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium'}>{needsInputLabel(progress[c.id],canSteer)}</span>:null}<ArrowUpRight aria-hidden className="h-3.5 w-3.5 text-muted-foreground"/></span></div><p className="mt-2 text-xs text-muted-foreground">{sessionCardState(c,progress[c.id],canSteer)}</p></button>)}</div>
  {truncated?<p role="status" className="mt-2 text-xs text-muted-foreground">Showing the first {claims.length} sessions. Older history is not loaded.</p>:null}
 </section>;
}
