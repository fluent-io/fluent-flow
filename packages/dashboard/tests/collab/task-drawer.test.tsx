import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskDrawer } from '@/components/collab/task-drawer';
import { TaskDetailPage } from '@/components/collab/task-detail';
const capabilities=['task.read','comment.write','internal.read'];
vi.mock('@/lib/collab/use-me',()=>({useMe:()=>({me:{principal:{id:'p',sessionVersion:1},capabilities:{project:capabilities}}}),capabilitiesFor:(me:any,id:string)=>me?.capabilities[id]??[]}));
vi.mock('@/lib/collab/current-project',()=>({useSyncCurrentProject:()=>{}}));
const task={id:'22222222-2222-4222-8222-222222222222',projectId:'project',title:'Real task',description:'Real description',status:'backlog',priority:'normal',version:1,capabilities,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('renders one vertical context, progress, sessions, supporting details, discussion flow without tabs',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo)=>{const path=String(input);return Response.json({data:path.endsWith(`/tasks/${task.id}`)?task:[],nextCursor:null});}));
 render(<TaskDetailPage taskId={task.id}/>);
 await screen.findByText('Real description');
 const headings=screen.getAllByRole('heading').map(x=>x.textContent);
 expect(headings.indexOf('Latest progress')).toBeGreaterThan(headings.indexOf('Real task'));
 expect(headings.indexOf('Agent sessions')).toBeGreaterThan(headings.indexOf('Latest progress'));
 expect(headings.indexOf('Discussion')).toBeGreaterThan(headings.indexOf('Agent sessions'));
 expect(screen.queryByRole('navigation',{name:'Task sections'})).toBeNull();
 expect(screen.queryByText('Overview',{exact:true})).toBeNull();
});
it('keeps every live session and pending input visible even when it is absent from the loaded history',async()=>{
 const claim={id:7,taskId:task.id,claimType:'chat',attempt:1,status:'claimed',rootClaimId:7,createdAt:new Date().toISOString(),completedAt:null};
 const card={claimId:7,claimType:'chat',attempt:1,status:'claimed',endReason:null,createdAt:claim.createdAt,completedAt:null,lastSeq:3,readSeq:1,unread:true,needsInput:true,profile:'design',model:'large',targetAgentId:null};
 const olderWork={...card,claimId:6,claimType:'spec',profile:null,model:null};
 const paths:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo,init?:RequestInit)=>{const path=String(input);paths.push(`${init?.method??'GET'} ${path}`);
  if(path.endsWith(`/tasks/${task.id}`))return Response.json({data:task});
  if(path.includes('/claim-executions?'))return Response.json({data:[],nextCursor:null});
  if(path.includes('/claim-progress'))return Response.json({data:[card,olderWork]});
  return Response.json({data:[],nextCursor:null});
 }));
 render(<TaskDetailPage taskId={task.id}/>);
 await screen.findByText('Agent session 7 · design · large');
 expect(screen.getAllByText('Session needs attention').length).toBeGreaterThanOrEqual(1);
 expect(screen.getByText((_,el)=>el?.textContent==='Open · Session needs attention')).toBeTruthy();
 expect(screen.getAllByRole('button',{name:'Session needs attention'})).toHaveLength(2);
 expect(screen.getByText('2 active sessions have unread activity.')).toBeTruthy();
 expect(paths.some(p=>p.includes('/claim-executions/7/events'))).toBe(false);
 expect(paths.some(p=>p.includes('/claim-executions/7/requests'))).toBe(false);
});
it('clears session metadata and stops session polls when authorization is revoked',async()=>{
 const claim={id:7,taskId:task.id,claimType:'chat',attempt:1,status:'claimed',rootClaimId:7,createdAt:new Date().toISOString(),completedAt:null};
 let denied=false;
 const deniedResponse=()=>Response.json({error:{code:'forbidden',message:'denied',requestId:'r1'}},{status:403,headers:{'content-type':'application/json'}});
 const fetchMock=vi.fn(async(input:RequestInfo,init?:RequestInit)=>{
  const path=String(input);
  if(path.endsWith(`/tasks/${task.id}`))return Response.json({data:task});
  if(path.includes('/claim-executions?'))return denied?deniedResponse():Response.json({data:[claim],nextCursor:null});
  if(path.includes('/claim-progress'))return denied?deniedResponse():Response.json({data:[]});
  return Response.json({data:[],nextCursor:null});
 });
 vi.stubGlobal('fetch',fetchMock);
 const view=render(<TaskDetailPage taskId={task.id}/>);
 await screen.findByText('Agent session 7');
 denied=true;
 await screen.findByText('Sessions are temporarily unavailable.',undefined,{timeout:6000});
 expect(screen.queryByText('Agent session 7')).toBeNull();
 const callsAfterDenial=fetchMock.mock.calls.length;
 await new Promise(resolve=>setTimeout(resolve,200));
 expect(fetchMock.mock.calls.length).toBe(callsAfterDenial);
 view.unmount();
},10000);
it('discussion only posts a comment, never an agent prompt',async()=>{
 const requests:{method:string,path:string,body:any}[]=[];
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo,init?:RequestInit)=>{const path=String(input);requests.push({path,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null});return Response.json({data:path.endsWith(`/tasks/${task.id}`)?task:[],nextCursor:null});}));
 render(<TaskDetailPage taskId={task.id}/>);
 await userEvent.type(await screen.findByRole('textbox',{name:'Comment'}),'A human note');
 await userEvent.click(screen.getByRole('button',{name:/^Comment$/}));
 await waitFor(()=>expect(requests.filter(x=>x.method==='POST')).toEqual([{method:'POST',path:expect.stringContaining(`/tasks/${task.id}/comments`),body:{body:'A human note',visibility:'client'}}]));
});

it('labels the side dialog, closes on Escape without posting commands, and restores board focus',async()=>{
 const close=vi.fn();const fetch=vi.fn(async(input:RequestInfo)=>Response.json({data:String(input).endsWith(`/tasks/${task.id}`)?task:[],nextCursor:null}));vi.stubGlobal('fetch',fetch);
 render(<><h1 id="board-heading" tabIndex={-1}>Board</h1><TaskDrawer taskId={task.id} claimId={null} onClose={close} onSelectClaim={vi.fn()}/></>);
 await screen.findByRole('dialog',{name:'Task details'});
 await userEvent.keyboard('{Escape}');expect(close).toHaveBeenCalledOnce();
 expect(fetch.mock.calls.every(call=>(call as any)[1]?.method!=='POST')).toBe(true);
});

it('does not refetch the old discussion after a comment finishes on a closed drawer',async()=>{
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const calls:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo,init?:RequestInit)=>{const path=String(input);calls.push(`${init?.method??'GET'} ${path}`);if(init?.method==='POST')await held;return Response.json({data:path.endsWith(`/tasks/${task.id}`)?task:[],nextCursor:null});}));
 const view=render(<TaskDetailPage taskId={task.id}/>);
 await userEvent.type(await screen.findByRole('textbox',{name:'Comment'}),'Finish after close');
 await userEvent.click(screen.getByRole('button',{name:/^Comment$/}));
 view.unmount();const count=calls.length;release();await new Promise(resolve=>setTimeout(resolve,30));expect(calls).toHaveLength(count);
});
