import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {StartTaskWork} from '@/components/collab/start-task-work';
const detail={id:'task',version:3,status:'ready',description:'Do the approved change',capabilities:['run.start']} as any;
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('starts a Ready task as spec work, never a chat, only after explicit Start',async()=>{
 const requests:any[]=[];vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo,init?:RequestInit)=>{requests.push({url:String(input),body:JSON.parse(String(init?.body))});return Response.json({data:{claim:{id:51},created:true}});}));
 const selected=vi.fn();render(<StartTaskWork detail={detail} repo="owner/repo" reload={vi.fn(async()=>{})} onSelectClaim={selected}/>);
 expect(requests).toHaveLength(0);await userEvent.click(screen.getByRole('button',{name:'Start'}));
 await waitFor(()=>expect(selected).toHaveBeenCalledWith(51));expect(requests[0].body).toEqual({expectedVersion:3,claimType:'spec',repo:'owner/repo',instructions:'Do the approved change'});
});
it('does not offer Start on Backlog tasks or to readers',()=>{
 const {rerender}=render(<StartTaskWork detail={{...detail,status:'backlog'}} repo="owner/repo" reload={vi.fn()} onSelectClaim={vi.fn()}/>);expect(screen.queryByRole('button',{name:'Start'})).toBeNull();
 rerender(<StartTaskWork detail={{...detail,capabilities:['task.read']}} repo="owner/repo" reload={vi.fn()} onSelectClaim={vi.fn()}/>);expect(screen.queryByRole('button',{name:'Start'})).toBeNull();
});

it('retries a lost response with the original description and version despite task polling',async()=>{
 const payloads:any[]=[];vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo,init?:RequestInit)=>{payloads.push(JSON.parse(String(init?.body)));return Response.json({error:{code:'internal_error',message:'Unavailable'}},{status:503});}));
 const view=render(<StartTaskWork detail={detail} repo="owner/repo" reload={vi.fn()} onSelectClaim={vi.fn()}/>);
 await userEvent.click(screen.getByRole('button',{name:'Start'}));await screen.findByRole('alert');
 view.rerender(<StartTaskWork detail={{...detail,version:4,description:'Changed elsewhere'}} repo="owner/repo" reload={vi.fn()} onSelectClaim={vi.fn()}/>);
 await userEvent.click(screen.getByRole('button',{name:'Start'}));await waitFor(()=>expect(payloads).toHaveLength(2));expect(payloads[1]).toEqual(payloads[0]);
});

it('uses a fresh request identity for a new explicit start after a successful one', async () => {
 const keys:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo,init?:RequestInit)=>{
  keys.push(new Headers(init?.headers).get('Idempotency-Key')!);
  return Response.json({data:{claim:{id:51},created:true}});
 }));
 const view=render(<StartTaskWork detail={detail} repo="owner/repo" reload={async()=>{}} onSelectClaim={()=>{}}/>);
 await userEvent.click(screen.getByRole('button',{name:'Start'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Start'}).hasAttribute('disabled')).toBe(false));
 view.rerender(<StartTaskWork detail={{...detail,version:4}} repo="owner/repo" reload={async()=>{}} onSelectClaim={()=>{}}/>);
 await userEvent.click(screen.getByRole('button',{name:'Start'}));
 await waitFor(()=>expect(keys).toHaveLength(2));
 expect(keys[1]).not.toBe(keys[0]);
});
