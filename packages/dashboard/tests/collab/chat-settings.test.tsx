import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {ChatExecutionSettings} from '@/components/collab/chat-execution-settings';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const saved={version:3,executionMode:'chat',defaultAgentId:'agent',defaults:{profileId:'design',model:'small',instructions:'Saved'},agents:[{id:'agent',available:true,profiles:[{id:'design',models:['small','large'],default_model:'small'}],busyChat:0,busyWork:1,maxChatSlots:null}]};
it('pins draft base version across a 409 and refresh until explicit Reload defaults',async()=>{
 const writes:any[]=[];let version=3;
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo,init?:RequestInit)=>{
  if(init?.method==='PATCH'){writes.push(JSON.parse(String(init.body)));version=4;return Response.json({error:{code:'version_conflict',message:'Changed'}},{status:409});}
  return Response.json({data:{...saved,version,defaults:{...saved.defaults,instructions:version===3?'Saved':'Remote'}}});
 }));
 render(<ChatExecutionSettings projectId="project" onChanged={vi.fn(async()=>{})}/>);
 const field=await screen.findByRole('textbox',{name:'Default instructions'});await userEvent.clear(field);await userEvent.type(field,'My draft');
 await userEvent.click(screen.getByRole('button',{name:'Save execution settings'}));await screen.findByRole('alert');
 expect((field as HTMLTextAreaElement).value).toBe('My draft');
 await userEvent.click(screen.getByRole('button',{name:'Save execution settings'}));await waitFor(()=>expect(writes).toHaveLength(2));expect(writes.every(w=>w.expectedVersion===3)).toBe(true);
 await userEvent.click(screen.getByRole('button',{name:'Reload defaults'}));await waitFor(()=>expect((screen.getByRole('textbox',{name:'Default instructions'}) as HTMLTextAreaElement).value).toBe('Remote'));
});
it('clears private drafts when the settings endpoint denies access',async()=>{
 let denied=false;vi.stubGlobal('fetch',vi.fn(async()=>denied?Response.json({error:{code:'forbidden',message:'Denied'}},{status:403}):Response.json({data:saved})));
 render(<ChatExecutionSettings projectId="project" onChanged={vi.fn(async()=>{})}/>);
 const field=await screen.findByRole('textbox',{name:'Default instructions'});await userEvent.type(field,'Private');denied=true;
 await userEvent.click(screen.getByRole('button',{name:'Reload defaults'}));await waitFor(()=>expect(screen.queryByRole('textbox',{name:'Default instructions'})).toBeNull());expect(screen.queryByDisplayValue('SavedPrivate')).toBeNull();
});
