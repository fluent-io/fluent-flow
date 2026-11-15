import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NewSessionDialog} from '@/components/collab/new-session-dialog';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('atomically creates the task and chat with immutable retry identity, never POSTs a separate task',async()=>{
 const records:any[]=[];let attempt=0;const created=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo,init?:RequestInit)=>{records.push({url:String(input),body:JSON.parse(String(init?.body)),key:new Headers(init?.headers).get('Idempotency-Key')});return ++attempt===1?Response.json({error:{code:'internal_error',message:'Unavailable'}},{status:503}):Response.json({data:{taskId:'task',claim:{id:41},created:false}});}));
 render(<React.StrictMode><NewSessionDialog projects={[{id:'p',name:'Project'} as any]} onClose={vi.fn()} onCreated={created}/></React.StrictMode>);
 await userEvent.type(screen.getByRole('textbox',{name:'Session title'}),'Design the change');
 await userEvent.click(screen.getByRole('button',{name:'Create session'}));await screen.findByRole('alert');
 await userEvent.click(screen.getByRole('button',{name:'Create session'}));
 await waitFor(()=>expect(created).toHaveBeenCalledOnce());expect(records).toHaveLength(2);expect(records[0]).toEqual(records[1]);expect(records[0].url).toMatch(/\/projects\/p\/chat-sessions$/);expect(records[0].body).toEqual({title:'Design the change',repo:null});
});
