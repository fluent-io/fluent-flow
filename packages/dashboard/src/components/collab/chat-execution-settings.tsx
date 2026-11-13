'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {ApiError,collabFetch} from '@/lib/collab/api';
import {LatestRequest} from '@/lib/collab/live';
type Defaults={profileId:string|null;model:string|null;instructions:string};
type Settings={version:number;executionMode:'chat'|'connector';defaultAgentId:string|null;defaults:Defaults;agents:{id:string;available:boolean;online:boolean;chatDisabled:boolean;effectiveChatSlots:number|null;profiles:{id:string;models:string[];default_model?:string}[];busyChat:number;busyWork:number;maxChatSlots:number|null}[]};
export function ChatExecutionSettings({projectId,onChanged,onMode}:{projectId:string;onChanged:()=>Promise<void>;onMode?:(mode:'chat'|'connector')=>void}){
 const [saved,setSaved]=useState<Settings|null>(null);const [draft,setDraft]=useState<Settings|null>(null);
 const [error,setError]=useState<string|null>(null);const [denied,setDenied]=useState(false);const [busy,setBusy]=useState(false);
 const request=useRef(new LatestRequest());const alive=useRef(true);const inFlight=useRef(false);
 const onModeRef=useRef(onMode);onModeRef.current=onMode;
 const load=useCallback(async()=>{const signal=request.current.begin();try{const result=await collabFetch<Settings>(`/projects/${projectId}/execution-settings`,{signal});if(!request.current.current(signal))return;setSaved(result.data);setDraft(result.data);setError(null);setDenied(false);onModeRef.current?.(result.data.executionMode);}catch(err){if(!request.current.current(signal))return;if(err instanceof ApiError&&[401,403,404].includes(err.status)){setDraft(null);setSaved(null);setDenied(true);}setError('Execution settings are unavailable. Reload to try again.');}},[projectId]);
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;request.current.dispose();};},[load]);
 async function save(){if(!draft||inFlight.current)return;inFlight.current=true;setBusy(true);setError(null);
  const payload={expectedVersion:draft.version,executionMode:draft.executionMode,defaultAgentId:draft.defaultAgentId,defaults:draft.defaults};
  try{const result=await collabFetch<Settings>(`/projects/${projectId}/execution-settings`,{method:'PATCH',body:payload});if(!alive.current)return;setSaved(result.data);setDraft(result.data);onModeRef.current?.(result.data.executionMode);await onChanged();}
  catch(err){if(!alive.current)return;if(err instanceof ApiError&&[401,403,404].includes(err.status)){setDraft(null);setSaved(null);setDenied(true);}setError(err instanceof ApiError&&err.status===409?'These settings changed. Your draft is preserved. Reload defaults to discard it and use the current settings.':'Could not save settings. Your draft is preserved.');}
  finally{inFlight.current=false;if(alive.current)setBusy(false);}
 }
 const agent=draft?.agents.find(a=>a.id===draft.defaultAgentId);
 const profile=agent?.profiles.find(p=>p.id===draft?.defaults.profileId);
 const selectClass='mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm';
 return <section aria-label="Agent execution settings" className="rounded-lg border border-border bg-card p-4">
  <h2 className="text-sm font-medium">Attended execution</h2>
  <p className="mt-2 text-xs text-muted-foreground">Agent sessions run on operator infrastructure. Steering can execute code with the agent’s access. Start remains unattended work.</p>
  {error?<p role="alert" className="mt-3 text-sm text-destructive">{error}</p>:null}
  {!saved&&!error?<p role="status" className="mt-3 text-sm">Loading execution settings…</p>:null}
  {!denied&&draft?<div className="mt-4 space-y-4">
   <label className="block text-sm">Session implementation<select aria-label="Session implementation" className={selectClass} disabled={busy} value={draft.executionMode} onChange={e=>setDraft({...draft,executionMode:e.target.value as Settings['executionMode']})}><option value="chat">Agent chat</option><option value="connector">Legacy connector</option></select></label>
   <label className="block text-sm">Default agent<select aria-label="Default agent" className={selectClass} disabled={busy} value={draft.defaultAgentId??''} onChange={e=>setDraft({...draft,defaultAgentId:e.target.value||null,defaults:{...draft.defaults,profileId:null,model:null}})}><option value="">Any eligible agent</option>{draft.defaultAgentId&&!agent?<option value={draft.defaultAgentId}>{draft.defaultAgentId} · unavailable</option>:null}{draft.agents.map(a=><option key={a.id} value={a.id} disabled={a.chatDisabled}>{a.id}{a.chatDisabled?' · chats disabled':a.online===false?' · offline':a.effectiveChatSlots==null?' · capacity unknown':a.available?'':' · unavailable'}</option>)}</select></label>
   {agent?<p className="text-xs text-muted-foreground">Busy: {agent.busyChat+agent.busyWork} (chat {agent.busyChat} / work {agent.busyWork}). {agent.chatDisabled?'Chats disabled on this agent.':agent.effectiveChatSlots==null?'Chat capacity has not been reported.':`Chat capacity: ${agent.effectiveChatSlots}; at least one work slot remains reserved.`}</p>:null}
   <label className="block text-sm">Default profile<select aria-label="Default profile" className={selectClass} disabled={busy||!agent} value={draft.defaults.profileId??''} onChange={e=>setDraft({...draft,defaults:{...draft.defaults,profileId:e.target.value||null,model:null}})}><option value="">Runner default</option>{draft.defaults.profileId&&!profile?<option value={draft.defaults.profileId}>{draft.defaults.profileId} · unavailable</option>:null}{agent?.profiles.map(p=><option key={p.id} value={p.id}>{p.id}</option>)}</select></label>
   <label className="block text-sm">Model override<select aria-label="Model override" className={selectClass} disabled={busy||!profile} value={draft.defaults.model??''} onChange={e=>setDraft({...draft,defaults:{...draft.defaults,model:e.target.value||null}})}><option value="">Profile default</option>{draft.defaults.model&&!profile?.models.includes(draft.defaults.model)?<option value={draft.defaults.model}>{draft.defaults.model} · unavailable</option>:null}{profile?.models.map(model=><option key={model} value={model}>{model}</option>)}</select></label>
   <label className="block text-sm">Default instructions<textarea aria-label="Default instructions" disabled={busy} maxLength={20000} rows={4} className="mt-1 w-full rounded-md border border-border bg-background p-3 text-sm" value={draft.defaults.instructions} onChange={e=>setDraft({...draft,defaults:{...draft.defaults,instructions:e.target.value}})}/></label>
   <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={()=>void save()}>Save execution settings</Button><Button variant="outline" size="sm" disabled={busy} onClick={()=>void load()}>Reload defaults</Button></div>
   <p className="text-xs text-muted-foreground">Saved selections are never silently replaced when an agent is offline. Run-summary configuration and connector history remain available until migration.</p>
  </div>:<Button variant="outline" size="sm" className="mt-3" onClick={()=>void load()}>Reload defaults</Button>}
 </section>;
}
