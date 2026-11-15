'use client';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {ApiError,collabFetch} from '@/lib/collab/api';
import type {StartClaimExecutionResult} from '@/lib/collab/types';
import type {TaskDetail} from './task-detail';
export function StartTaskWork({detail,repo,reload,onSelectClaim}:{detail:TaskDetail;repo:string|null;reload:()=>Promise<void>;onSelectClaim:(id:number)=>void}){
 const [repository,setRepository]=useState(repo??'');const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
 const intent=useRef<{key:string;body:{expectedVersion:number;claimType:'spec';repo:string;instructions:string}}|null>(null);const inFlight=useRef(false);const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 if(detail.status!=='ready'||!detail.capabilities?.includes('run.start'))return null;
 async function start(event:React.FormEvent){event.preventDefault();if(inFlight.current||!repository.trim())return;inFlight.current=true;setBusy(true);setError(null);
  const current = intent.current ?? {key:crypto.randomUUID(),body:{expectedVersion:detail.version,claimType:'spec' as const,repo:repository.trim(),instructions:detail.description.slice(0,20000)}};
  intent.current=current;
  try{const result=await collabFetch<StartClaimExecutionResult>(`/tasks/${detail.id}/claim-executions`,{method:'POST',idempotencyKey:current.key,body:current.body});if(alive.current){intent.current=null;onSelectClaim(result.data.claim.id);await reload();}}
  catch(err){if(alive.current)setError(err instanceof ApiError&&err.status===409?'The task changed. Refresh before starting.':'Could not start unattended work. Retry preserves this request.');}
  finally{inFlight.current=false;if(alive.current)setBusy(false);}
 }
 return <form onSubmit={event=>void start(event)} className="mt-4 space-y-2">
  {!repo?<label className="block text-xs text-muted-foreground">Repository for unattended work<Input aria-label="Work repository" required pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" disabled={busy} placeholder="owner/name" value={repository} onChange={event=>{setRepository(event.target.value);intent.current=null;}}/></label>:null}
  <Button type="submit" size="sm" disabled={busy||!repository.trim()}>Start</Button><span className="ml-2 text-xs text-muted-foreground">Unattended work · no chat required</span>
  {error?<p role="alert" className="text-xs text-destructive">{error}<Button type="button" variant="ghost" size="sm" onClick={()=>{intent.current=null;void reload();}}>Refresh task</Button></p>:null}
 </form>;
}
