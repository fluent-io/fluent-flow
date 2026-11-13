'use client';
import {useEffect,useRef,useState} from 'react';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {collabFetch} from '@/lib/collab/api';
import type {NewChatSessionResult,Project} from '@/lib/collab/types';
export function NewSessionDialog({projects,onClose,onCreated}:{projects:Project[];onClose:()=>void;onCreated:(result:NewChatSessionResult)=>void}){
 const [projectId,setProjectId]=useState(projects[0]?.id??'');const [title,setTitle]=useState('');const [repo,setRepo]=useState('');
 const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
 const key=useRef(crypto.randomUUID());const active=useRef(true);const inFlight=useRef(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 function changed(){key.current=crypto.randomUUID();setError(null);}
 async function submit(event:React.FormEvent){event.preventDefault();if(inFlight.current||!title.trim()||!projects.some(p=>p.id===projectId))return;inFlight.current=true;setBusy(true);setError(null);
  try{const result=await collabFetch<NewChatSessionResult>(`/projects/${projectId}/chat-sessions`,{method:'POST',idempotencyKey:key.current,body:{title:title.trim(),repo:repo.trim()||null}});if(active.current)onCreated(result.data);}
  catch{if(active.current)setError('Could not create the session. Try again; the same request will be reused.');}
  finally{inFlight.current=false;if(active.current)setBusy(false);}
 }
 return <Dialog open onOpenChange={open=>{if(!open)onClose();}}><DialogContent><DialogTitle>New session</DialogTitle><DialogDescription>Create a Backlog task and open an attended agent session. No prompt is sent until you send one.</DialogDescription>
 <form onSubmit={event=>void submit(event)} className="space-y-4">
 <label className="block text-sm">Project<select aria-label="Session project" disabled={busy} className="mt-1 h-9 w-full rounded border border-border bg-background px-2" value={projectId} onChange={e=>{changed();setProjectId(e.target.value);}}>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
 <label className="block text-sm">Session title<Input aria-label="Session title" maxLength={300} required disabled={busy} value={title} onChange={e=>{changed();setTitle(e.target.value);}}/></label>
 <label className="block text-sm">Repository (optional)<Input aria-label="Session repository" placeholder="owner/name" maxLength={200} disabled={busy} value={repo} onChange={e=>{changed();setRepo(e.target.value);}} pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"/></label>
 {error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}
 <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy||!title.trim()}>Create session</Button></div>
 </form></DialogContent></Dialog>;
}
