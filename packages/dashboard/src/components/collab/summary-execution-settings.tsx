'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {ApiError,collabFetch} from '@/lib/collab/api';
import {LatestRequest} from '@/lib/collab/live';

type SummaryDefaults={enabled:boolean;agentId:string|null;profileId:string|null;model:string|null};
type SummaryAgent={id:string;online:boolean;available:boolean;capacity:number|null;busy:number;profiles:{id:string;models:string[];default_model?:string}[]};
type SummarySettings={version:number;defaults:SummaryDefaults;agents:SummaryAgent[]};

type SummarySettingsProps={projectId:string;onChanged:()=>Promise<void>};

export function SummaryExecutionSettings(props:SummarySettingsProps){
 return <SummarySettingsPanel key={props.projectId} {...props}/>;
}

function SummarySettingsPanel({projectId,onChanged}:SummarySettingsProps){
 const [saved,setSaved]=useState<SummarySettings|null>(null);const [draft,setDraft]=useState<SummarySettings|null>(null);
 const [error,setError]=useState<string|null>(null);const [notice,setNotice]=useState<string|null>(null);
 const [denied,setDenied]=useState(false);const [busy,setBusy]=useState(false);
 const request=useRef(new LatestRequest());const alive=useRef(true);const inFlight=useRef(false);
 const load=useCallback(async()=>{const signal=request.current.begin();try{const result=await collabFetch<SummarySettings>(`/projects/${projectId}/summary-settings`,{signal});if(!request.current.current(signal))return;setSaved(result.data);setDraft(result.data);setError(null);setNotice(null);setDenied(false);}catch(err){if(!request.current.current(signal))return;if(err instanceof ApiError&&[401,403,404].includes(err.status)){setDraft(null);setSaved(null);setDenied(true);}setError('Summary settings are unavailable. Reload to try again.');}},[projectId]);
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;request.current.dispose();};},[load]);
 async function save(){
  if(!draft||inFlight.current)return;
  if(draft.defaults.enabled){
   const agent=draft.agents.find(candidate=>candidate.id===draft.defaults.agentId);
   const profile=agent?.profiles.find(candidate=>candidate.id===draft.defaults.profileId);
   if(!profile||(draft.defaults.model!==null&&!profile.models.includes(draft.defaults.model))){
    setError('Saved summaries need an agent that still advertises the selected profile and model. Reload defaults to discard the stale selection.');
    return;
   }
  }
  inFlight.current=true;setBusy(true);setError(null);setNotice(null);
  try{
   const result=await collabFetch<SummarySettings>(`/projects/${projectId}/summary-settings`,{method:'PATCH',body:{expectedVersion:draft.version,defaults:draft.defaults}});
   if(!alive.current)return;
   setSaved(result.data);setDraft(result.data);
   try{await onChanged();}catch{if(alive.current)setNotice('Saved. Refresh this page to load the latest settings.');}
  }
  catch(err){
   if(!alive.current)return;
   if(err instanceof ApiError&&[401,403,404].includes(err.status)){setDraft(null);setSaved(null);setDenied(true);}
   setError(err instanceof ApiError&&err.status===409?'These settings changed. Your draft is preserved. Reload defaults to discard it and use the current settings.':'Could not save settings. Your draft is preserved.');
  }
  finally{inFlight.current=false;if(alive.current)setBusy(false);}
 }
 const agent=draft?.agents.find(candidate=>candidate.id===draft.defaults.agentId);
 const profile=agent?.profiles.find(candidate=>candidate.id===draft?.defaults.profileId);
 const selectClass='mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm';
 const agentLabel=(candidate:SummaryAgent)=>candidate.id+(candidate.online===false?' · offline':candidate.available?'':' · unavailable');
 return <section aria-label="Native summary execution settings" className="rounded-lg border border-border bg-card p-4">
  <h2 className="text-sm font-medium">Native summaries</h2>
  <p className="mt-2 text-xs text-muted-foreground">Project summaries run on an explicit org-scoped runner you choose. Historical host summary configuration stays in legacy settings and is never remapped here.</p>
  {error?<p role="alert" className="mt-3 text-sm text-destructive">{error}</p>:null}
  {notice?<p role="status" className="mt-3 text-sm text-muted-foreground">{notice}</p>:null}
  {!saved&&!error?<p role="status" className="mt-3 text-sm">Loading summary settings…</p>:null}
  {!denied&&draft?<div className="mt-4 space-y-4">
   <label className="block text-sm">Summary execution<select aria-label="Summary execution" className={selectClass} disabled={busy} value={draft.defaults.enabled?'true':'false'} onChange={e=>setDraft({...draft,defaults:{...draft.defaults,enabled:e.target.value==='true'}})}><option value="false">Disabled</option><option value="true">Enabled</option></select></label>
   <label className="block text-sm">Summary agent<select aria-label="Summary agent" className={selectClass} disabled={busy} value={draft.defaults.agentId??''} onChange={e=>setDraft({...draft,defaults:{...draft.defaults,agentId:e.target.value||null,profileId:null,model:null}})}><option value="">No agent</option>{draft.defaults.agentId&&!agent?<option value={draft.defaults.agentId}>{draft.defaults.agentId} · unavailable</option>:null}{draft.agents.map(a=><option key={a.id} value={a.id}>{agentLabel(a)}</option>)}</select></label>
   {agent?<p className="text-xs text-muted-foreground">Busy: {agent.busy}. {agent.online===false?'Offline; summaries queue until the agent returns.':agent.available?'':'No live capacity is reported.'}</p>:null}
   <label className="block text-sm">Summary profile<select aria-label="Summary profile" className={selectClass} disabled={busy||!agent} value={draft.defaults.profileId??''} onChange={e=>setDraft({...draft,defaults:{...draft.defaults,profileId:e.target.value||null,model:null}})}><option value="">Choose profile</option>{draft.defaults.profileId&&!profile?<option value={draft.defaults.profileId}>{draft.defaults.profileId} · unavailable</option>:null}{agent?.profiles.map(p=><option key={p.id} value={p.id}>{p.id}</option>)}</select></label>
   <label className="block text-sm">Summary model<select aria-label="Summary model" className={selectClass} disabled={busy||!profile} value={draft.defaults.model??''} onChange={e=>setDraft({...draft,defaults:{...draft.defaults,model:e.target.value||null}})}><option value="">Profile default</option>{draft.defaults.model&&!profile?.models.includes(draft.defaults.model)?<option value={draft.defaults.model}>{draft.defaults.model} · unavailable</option>:null}{profile?.models.map(model=><option key={model} value={model}>{model}</option>)}</select></label>
   <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={()=>void save()}>Save summary settings</Button><Button variant="outline" size="sm" disabled={busy} onClick={()=>void load()}>Reload summary defaults</Button></div>
   <p className="text-xs text-muted-foreground">Offline runners keep their selection and queue work; removing an agent, profile or model from the catalog blocks enabling until a valid identity is chosen.</p>
  </div>:<Button variant="outline" size="sm" className="mt-3" onClick={()=>void load()}>Reload summary defaults</Button>}
 </section>;
}
