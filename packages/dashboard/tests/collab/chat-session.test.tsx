import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskSessions } from '@/components/collab/task-sessions';
import type {TaskDetail} from '@/components/collab/task-detail';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const detail={id:'22222222-2222-4222-8222-222222222222',projectId:'p',version:7,capabilities:['internal.read','run.start']} as TaskDetail;
it('opens a chat only on explicit Open session, keeping the exact task version and nullable repository',async()=>{
 const posts:any[]=[];const select=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo,init?:RequestInit)=>{if(init?.method==='POST'){posts.push({body:JSON.parse(String(init.body)),key:new Headers(init.headers).get('Idempotency-Key')});return Response.json({data:{claim:{id:41},created:true}});}return Response.json({data:[],nextCursor:null});}));
 render(<TaskSessions detail={detail} reload={vi.fn(async()=>{})} onSelectClaim={select}/>);
 await screen.findByText('No attended sessions yet.');expect(posts).toHaveLength(0);
 await userEvent.click(screen.getByRole('button',{name:'Open session'}));
 await waitFor(()=>expect(select).toHaveBeenCalledWith(41));
 expect(posts).toEqual([{body:{expectedVersion:7,claimType:'chat',repo:null},key:expect.any(String)}]);
});
it('reuses an already open session without another POST',async()=>{
 const fetch=vi.fn(async()=>Response.json({data:[{id:41,claimType:'chat',status:'claimed',attempt:1}],nextCursor:null}));vi.stubGlobal('fetch',fetch);const select=vi.fn();
 render(<TaskSessions detail={detail} reload={vi.fn(async()=>{})} onSelectClaim={select}/>);
 await screen.findByRole('button',{name:/Agent session 41/});await userEvent.click(screen.getByRole('button',{name:'Open session'}));expect(select).toHaveBeenCalledWith(41);expect(fetch.mock.calls.every(call=>(call as any)[1]?.method!=='POST')).toBe(true);
});
