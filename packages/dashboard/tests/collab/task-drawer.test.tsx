import React, { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskDrawer } from '@/components/collab/task-drawer';
import { TaskDetailPage, type TaskDetail } from '@/components/collab/task-detail';
import { IdeasTab } from '@/components/collab/task-ideas-tab';
import type { Idea } from '@/lib/collab/types';
import type { ClaimProgressCard } from '@/lib/collab/claim-progress';
import { ExecutionSourceLink } from '@/components/collab/execution-source-link';
const capabilities=['task.read','comment.write','internal.read'];
vi.mock('@/lib/collab/use-me',()=>({useMe:()=>({me:{principal:{id:'p',sessionVersion:1},capabilities:{project:capabilities}}}),capabilitiesFor:(me:any,id:string)=>me?.capabilities[id]??[]}));
vi.mock('@/lib/collab/current-project',()=>({useSyncCurrentProject:()=>{}}));
const task={id:'22222222-2222-4222-8222-222222222222',projectId:'project',title:'Real task',description:'Real description',status:'backlog',priority:'normal',version:1,capabilities,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
const ideaDetail: TaskDetail = { ...task, status: 'backlog', priority: 'normal', assigneeId: null, position: 'a0', blockedReason: null,
 capabilities: ['task.read', 'task.write', 'internal.read', 'run.steer'] };
const privateIdea: Idea = { id: '55555555-5555-4555-8555-555555555555', version: 1, provenance: 'agent',
 conversionTargetTaskId: null, conversionCommandId: null, conversionSessionId: null, conversionClaimId: null, conversionClaimCommandId: null,
 sourceTaskId: task.id, runId: null, sessionId: null, claimId: 7, title: 'Private design follow-up', body: 'Internal design context',
 status: 'inbox', conversionTargetId: null, visibility: 'internal', authorId: 'p', createdAt: task.createdAt };
const ideaChat: ClaimProgressCard = { claimId: 7, claimType: 'chat', attempt: 1, status: 'claimed', endReason: null,
 createdAt: task.createdAt, completedAt: null, lastSeq: 1, readSeq: 0, unread: true, needsInput: false,
 profile: 'design', model: 'large', targetAgentId: 'idea-runner' };
function taskData(path: string) {
 if (path.endsWith(`/tasks/${task.id}/summaries`)) return { summaries: [], generation: null };
 return path.endsWith(`/tasks/${task.id}`) ? task : [];
}
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('renders one vertical context, progress, sessions, supporting details, discussion flow without tabs',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo)=>{const path=String(input);return Response.json({data:taskData(path),nextCursor:null});}));
 render(<TaskDetailPage taskId={task.id} onSelectHistory={vi.fn()}/>);
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
  return Response.json({data:taskData(path),nextCursor:null});
 }));
 render(<TaskDetailPage taskId={task.id} onSelectHistory={vi.fn()}/>);
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
  return Response.json({data:taskData(path),nextCursor:null});
 });
 vi.stubGlobal('fetch',fetchMock);
 const view=render(<TaskDetailPage taskId={task.id} onSelectHistory={vi.fn()}/>);
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
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo,init?:RequestInit)=>{const path=String(input);requests.push({path,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null});return Response.json({data:taskData(path),nextCursor:null});}));
 render(<TaskDetailPage taskId={task.id} onSelectHistory={vi.fn()}/>);
 await userEvent.type(await screen.findByRole('textbox',{name:'Comment'}),'A human note');
 await userEvent.click(screen.getByRole('button',{name:/^Comment$/}));
 await waitFor(()=>expect(requests.filter(x=>x.method==='POST')).toEqual([{method:'POST',path:expect.stringContaining(`/tasks/${task.id}/comments`),body:{body:'A human note',visibility:'client'}}]));
});

it('labels the side dialog, closes on Escape without posting commands, and restores board focus',async()=>{
 const close=vi.fn();const fetch=vi.fn(async(input:RequestInfo)=>Response.json({data:taskData(String(input)),nextCursor:null}));vi.stubGlobal('fetch',fetch);
 render(<><h1 id="board-heading" tabIndex={-1}>Board</h1><TaskDrawer taskId={task.id} claimId={null} onClose={close} onSelectClaim={vi.fn()} onSelectHistory={vi.fn()}/></>);
 await screen.findByRole('dialog',{name:'Task details'});
 await userEvent.keyboard('{Escape}');expect(close).toHaveBeenCalledOnce();
 expect(fetch.mock.calls.every(call=>(call as any)[1]?.method!=='POST')).toBe(true);
});

it('does not refetch the old discussion after a comment finishes on a closed drawer',async()=>{
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const calls:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo,init?:RequestInit)=>{const path=String(input);calls.push(`${init?.method??'GET'} ${path}`);if(init?.method==='POST')await held;return Response.json({data:taskData(path),nextCursor:null});}));
 const view=render(<TaskDetailPage taskId={task.id} onSelectHistory={vi.fn()}/>);
 await userEvent.type(await screen.findByRole('textbox',{name:'Comment'}),'Finish after close');
 await userEvent.click(screen.getByRole('button',{name:/^Comment$/}));
 view.unmount();const count=calls.length;release();await new Promise(resolve=>setTimeout(resolve,30));expect(calls).toHaveLength(count);
});

it('opens read-only historical sessions from the task drawer without losing task context', async () => {
 const runId='33333333-3333-4333-8333-333333333333';
 const sessionId='44444444-4444-4444-8444-444444444444';
 const entry={runId,state:'cancelled',stage:'design',createdAt:'2026-11-13T01:00:00.123456Z',source:{kind:'legacy',runId}};
 const root=`/tasks/${task.id}/execution-history/${runId}`;
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo)=>{
  const path=String(input);
  if(path.includes('/timeline'))return Response.json({data:[{eventId:'historical-reply',kind:'timeline',payload:{item:{type:'assistant_message',text:'Original design decision'}},observedAt:entry.createdAt,providerCursor:null}]});
  if(path.includes(`${root}/sessions`))return Response.json({data:[{id:sessionId,runId,title:'Original work session',role:'work',state:'cancelled',profileId:null,model:null,createdAt:null}]});
  if(path.endsWith(root))return Response.json({data:entry});
  if(path.includes('/execution-history?'))return Response.json({data:[entry]});
  return Response.json({data:taskData(path),nextCursor:null});
 }));
 function HistoricalTask(){
  const [history,setHistory]=useState<{runId:string;sessionId:string|null}|null>(null);
  return <TaskDetailPage taskId={task.id} selectedRunId={history?.runId??null} selectedSessionId={history?.sessionId??null} onSelectHistory={setHistory}/>;
 }
 render(<HistoricalTask/>);
 await screen.findByText('Real description');
 await userEvent.click(screen.getByText('Run history',{exact:true}));
 await userEvent.click(await screen.findByRole('button',{name:/View historical execution/}));
 await userEvent.click(await screen.findByRole('button',{name:'Original work session'}));
 await screen.findByText('Original design decision');
 await userEvent.click(screen.getByRole('button',{name:'Back to task'}));
 await screen.findByText('Real description');
 expect(screen.getByText('Discussion',{exact:true})).toBeTruthy();
});

it('requires explicit idea session selection and never retargets a closed selection to its replacement', async () => {
 const fetchMock = vi.fn(async () => Response.json({ data: [privateIdea] }));
 vi.stubGlobal('fetch', fetchMock);
 const view = render(<IdeasTab detail={ideaDetail} claimProgress={[ideaChat]} sourceNavigation={{ onSelectClaim: vi.fn(), onSelectHistory: vi.fn() }} />);
 await screen.findByText(privateIdea.body);
 const select = screen.getByRole('combobox', { name: 'Follow-up session' }) as HTMLSelectElement;
 const send = screen.getByRole('button', { name: 'Send follow-up' }) as HTMLButtonElement;
 expect(select.value).toBe('');
 expect(send.disabled).toBe(true);
 await userEvent.selectOptions(select, '7');
 expect(send.disabled).toBe(false);
 view.rerender(<IdeasTab detail={ideaDetail} claimProgress={[{ ...ideaChat, status: 'completed' }, { ...ideaChat, claimId: 8 }]} sourceNavigation={{ onSelectClaim: vi.fn(), onSelectHistory: vi.fn() }} />);
 expect(select.value).toBe('7');
 expect(send.disabled).toBe(true);
 await userEvent.click(send);
 expect(screen.getByText(privateIdea.body)).toBeTruthy();
 await userEvent.selectOptions(select, '8');
 expect(send.disabled).toBe(false);
});

it('masks cached internal ideas and session controls immediately when internal authority is lost', async () => {
 const publicIdea: Idea = { ...privateIdea, id: '66666666-6666-4666-8666-666666666666', title: 'Public reminder', body: 'Visible discussion context', visibility: 'client', claimId: null };
 vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [privateIdea, publicIdea] })));
 const view = render(<IdeasTab detail={ideaDetail} claimProgress={[ideaChat]} sourceNavigation={{ onSelectClaim: vi.fn(), onSelectHistory: vi.fn() }} />);
 await screen.findByText(privateIdea.body);
 view.rerender(<IdeasTab detail={{ ...ideaDetail, capabilities: ['task.read', 'task.write'] }} claimProgress={[ideaChat]} sourceNavigation={{ onSelectClaim: vi.fn(), onSelectHistory: vi.fn() }} />);
 expect(screen.queryByText(privateIdea.title)).toBeNull();
 expect(screen.queryByText(privateIdea.body)).toBeNull();
 expect(screen.queryByRole('combobox', { name: 'Follow-up session' })).toBeNull();
 expect(screen.queryByRole('button', { name: 'View reporting session' })).toBeNull();
 expect(screen.getByText(publicIdea.body)).toBeTruthy();
});

it('does not navigate back to a previous task when its source lookup completes late', async () => {
 let release!: (response: Response) => void;
 vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
 const navigation = { onSelectClaim: vi.fn(), onSelectHistory: vi.fn() };
 const commandId = '77777777-7777-4777-8777-777777777777';
 const view = render(<ExecutionSourceLink taskId={task.id} source={{ commandId }} internalRead navigation={navigation} />);
 await userEvent.click(screen.getByRole('button', { name: 'View execution source' }));
 view.rerender(<ExecutionSourceLink taskId="88888888-8888-4888-8888-888888888888" source={{ commandId }} internalRead navigation={navigation} />);
 await act(async () => { release(Response.json({ data: { runId: '99999999-9999-4999-8999-999999999999', sessionId: null } })); });
 expect(navigation.onSelectHistory).not.toHaveBeenCalled();
 expect(screen.getByRole('button', { name: 'View execution source' })).toBeTruthy();
});

it('cannot restore source navigation after internal authority is revoked during a lookup', async () => {
 let release!: (response: Response) => void;
 vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
 const navigation = { onSelectClaim: vi.fn(), onSelectHistory: vi.fn() };
 const commandId = '77777777-7777-4777-8777-777777777777';
 const view = render(<ExecutionSourceLink taskId={task.id} source={{ commandId }} internalRead navigation={navigation} />);
 await userEvent.click(screen.getByRole('button', { name: 'View execution source' }));
 view.rerender(<ExecutionSourceLink taskId={task.id} source={{ commandId }} internalRead={false} navigation={navigation} />);
 await act(async () => { release(Response.json({ data: { runId: '99999999-9999-4999-8999-999999999999', sessionId: null } })); });
 expect(navigation.onSelectHistory).not.toHaveBeenCalled();
 expect(screen.queryByRole('button', { name: 'View execution source' })).toBeNull();
 expect(screen.queryByRole('status')).toBeNull();
});
