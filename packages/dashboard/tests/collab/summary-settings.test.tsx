import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {SummaryExecutionSettings} from '@/components/collab/summary-execution-settings';

afterEach(()=>{cleanup();vi.unstubAllGlobals();});

const agents=[
 {id:'runner',online:true,available:true,capacity:1,busy:0,profiles:[{id:'omp-work',models:['small','large'],default_model:'small'}]},
 {id:'idle',online:false,available:false,capacity:null,busy:0,profiles:[{id:'omp-work',models:['small']}]},
];

function select(name:string){return screen.getByRole('combobox',{name}) as HTMLSelectElement;}

it('keeps cost-changing selections empty until chosen explicitly',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo,init?:RequestInit)=>{
  if(init?.method==='PATCH')return Response.json({data:{version:8,defaults:{enabled:true,agentId:'runner',profileId:'omp-work',model:'small'},agents}});
  return Response.json({data:{version:7,defaults:{enabled:false,agentId:null,profileId:null,model:null},agents}});
 }));
 render(<SummaryExecutionSettings projectId="project" onChanged={vi.fn(async()=>{})}/>);
 await waitFor(()=>expect(select('Summary agent').value).toBe(''));
 expect(select('Summary profile').value).toBe('');
 expect(select('Summary model').value).toBe('');
 await userEvent.selectOptions(select('Summary agent'),'runner');
 expect(select('Summary profile').value).toBe('');
 expect(select('Summary model').value).toBe('');
 await userEvent.selectOptions(select('Summary profile'),'omp-work');
 expect(select('Summary model').value).toBe('');
 await userEvent.selectOptions(select('Summary model'),'large');
 await userEvent.selectOptions(select('Summary agent'),'runner');
 expect(select('Summary profile').value).toBe('');
 expect(select('Summary model').value).toBe('');
 await userEvent.selectOptions(select('Summary profile'),'omp-work');
 await userEvent.selectOptions(select('Summary model'),'small');
 await userEvent.selectOptions(select('Summary execution'),'true');
 await userEvent.click(screen.getByRole('button',{name:'Save summary settings'}));
 await waitFor(()=>expect(select('Summary execution').value).toBe('true'));
 expect(select('Summary agent').value).toBe('runner');
 expect(select('Summary model').value).toBe('small');
 expect(screen.queryByRole('alert')).toBeNull();
});

it('saves an enabled selection on an offline runner with an advertised catalog',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo,init?:RequestInit)=>{
  if(init?.method==='PATCH')return Response.json({data:{version:6,defaults:{enabled:true,agentId:'idle',profileId:'omp-work',model:'small'},agents}});
  return Response.json({data:{version:5,defaults:{enabled:false,agentId:'idle',profileId:'omp-work',model:'small'},agents}});
 }));
 render(<SummaryExecutionSettings projectId="project" onChanged={vi.fn(async()=>{})}/>);
 await waitFor(()=>expect(select('Summary agent').value).toBe('idle'));
 expect(screen.getByRole('option',{name:/offline/i})).toBeTruthy();
 await userEvent.selectOptions(select('Summary execution'),'true');
 await userEvent.click(screen.getByRole('button',{name:'Save summary settings'}));
 await waitFor(()=>expect(select('Summary execution').value).toBe('true'));
 expect(select('Summary agent').value).toBe('idle');
 expect(select('Summary profile').value).toBe('omp-work');
 expect(select('Summary model').value).toBe('small');
 expect(screen.queryByRole('alert')).toBeNull();
});

it('preserves the draft across a shared-version conflict until explicit reload',async()=>{
 let version=7;
 vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo,init?:RequestInit)=>{
  if(init?.method==='PATCH'){version=8;return Response.json({error:{code:'version_conflict',message:'Changed'}},{status:409});}
  return Response.json({data:{version,defaults:{enabled:false,agentId:'runner',profileId:'omp-work',model:null},agents}});
 }));
 render(<SummaryExecutionSettings projectId="project" onChanged={vi.fn(async()=>{})}/>);
 const model=await screen.findByRole('combobox',{name:'Summary model'}) as HTMLSelectElement;
 await userEvent.selectOptions(model,'large');
 await userEvent.click(screen.getByRole('button',{name:'Save summary settings'}));
 await screen.findByRole('alert');
 expect(model.value).toBe('large');
 await userEvent.click(screen.getByRole('button',{name:'Reload summary defaults'}));
 await waitFor(()=>expect((screen.getByRole('combobox',{name:'Summary model'}) as HTMLSelectElement).value).toBe(''));
 expect(screen.queryByRole('alert')).toBeNull();
});

it('blocks enabling a removed selection but saves it disabled unchanged',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo,init?:RequestInit)=>{
  if(init?.method==='PATCH')return Response.json({data:{version:9,defaults:{enabled:false,agentId:'gone',profileId:'old',model:'legacy'},agents:[]}});
  return Response.json({data:{version:8,defaults:{enabled:false,agentId:'gone',profileId:'old',model:'legacy'},agents:[]}});
 }));
 render(<SummaryExecutionSettings projectId="project" onChanged={vi.fn(async()=>{})}/>);
 await waitFor(()=>expect(select('Summary agent').value).toBe('gone'));
 await userEvent.selectOptions(select('Summary execution'),'true');
 await userEvent.click(screen.getByRole('button',{name:'Save summary settings'}));
 await screen.findByRole('alert');
 expect(select('Summary agent').value).toBe('gone');
 expect(select('Summary execution').value).toBe('true');
 await userEvent.selectOptions(select('Summary execution'),'false');
 await userEvent.click(screen.getByRole('button',{name:'Save summary settings'}));
 await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());
 expect(select('Summary agent').value).toBe('gone');
 expect(select('Summary profile').value).toBe('old');
 expect(select('Summary model').value).toBe('legacy');
});

it('blocks enabling a model the profile no longer advertises and keeps the draft',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:{version:4,defaults:{enabled:false,agentId:'runner',profileId:'omp-work',model:'ghost'},agents}})));
 render(<SummaryExecutionSettings projectId="project" onChanged={vi.fn(async()=>{})}/>);
 await waitFor(()=>expect(select('Summary model').value).toBe('ghost'));
 await userEvent.selectOptions(select('Summary execution'),'true');
 await userEvent.click(screen.getByRole('button',{name:'Save summary settings'}));
 await screen.findByRole('alert');
 expect(select('Summary model').value).toBe('ghost');
 expect(select('Summary agent').value).toBe('runner');
});

it('reports a saved refresh notice instead of a save failure when the reload breaks',async()=>{
 let savedOnce=false;
 const onChanged=vi.fn(async()=>{throw new Error('reload failed');});
 vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo,init?:RequestInit)=>{
  if(init?.method==='PATCH'){savedOnce=true;return Response.json({data:{version:9,defaults:{enabled:true,agentId:'runner',profileId:'omp-work',model:null},agents}});}
  if(savedOnce)return Promise.reject(new Error('network down'));
  return Response.json({data:{version:7,defaults:{enabled:false,agentId:'runner',profileId:'omp-work',model:null},agents}});
 }));
 render(<SummaryExecutionSettings projectId="project" onChanged={onChanged}/>);
 await waitFor(()=>expect(select('Summary execution').value).toBe('false'));
 await userEvent.selectOptions(select('Summary execution'),'true');
 await userEvent.click(screen.getByRole('button',{name:'Save summary settings'}));
 await waitFor(()=>expect(onChanged).toHaveBeenCalledTimes(1));
 await waitFor(()=>expect(select('Summary execution').value).toBe('true'));
 expect(screen.getByRole('status')).toBeTruthy();
 expect(screen.queryByRole('alert')).toBeNull();
});

it('clears private draft state when saving is denied',async()=>{
 let denied=false;
 vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo,init?:RequestInit)=>{
  if(init?.method==='PATCH'){denied=true;return Response.json({error:{code:'forbidden',message:'Denied'}},{status:403});}
  return denied?Response.json({error:{code:'forbidden',message:'Denied'}},{status:403}):Response.json({data:{version:7,defaults:{enabled:false,agentId:'runner',profileId:'omp-work',model:null},agents}});
 }));
 render(<SummaryExecutionSettings projectId="project" onChanged={vi.fn(async()=>{})}/>);
 await waitFor(()=>expect(select('Summary agent').value).toBe('runner'));
 await userEvent.selectOptions(select('Summary model'),'small');
 await userEvent.click(screen.getByRole('button',{name:'Save summary settings'}));
 await waitFor(()=>expect(screen.queryByRole('combobox',{name:'Summary agent'})).toBeNull());
 expect(screen.queryByRole('combobox',{name:'Summary profile'})).toBeNull();
 expect(screen.queryByRole('combobox',{name:'Summary model'})).toBeNull();
 expect(screen.queryByRole('combobox',{name:'Summary execution'})).toBeNull();
 expect(screen.queryByRole('button',{name:'Save summary settings'})).toBeNull();
});

it('ignores a delayed response from the previous project',async()=>{
 let resolveProjectA:(response:Response)=>void=()=>{};
 const delayedProjectA=new Promise<Response>(resolve=>{resolveProjectA=resolve;});
 const projectB={version:3,defaults:{enabled:false,agentId:'bee',profileId:'bee-profile',model:null},agents:[{id:'bee',online:true,available:true,capacity:2,busy:1,profiles:[{id:'bee-profile',models:['bee-model']}]}]};
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo,init?:RequestInit)=>{
  if(init?.method==='PATCH')return Response.json({data:projectB});
  if(String(input).includes('/projects/a/summary-settings'))return delayedProjectA;
  return Response.json({data:projectB});
 }));
 const view=render(<SummaryExecutionSettings projectId="a" onChanged={vi.fn(async()=>{})}/>);
 view.rerender(<SummaryExecutionSettings projectId="b" onChanged={vi.fn(async()=>{})}/>);
 await waitFor(()=>expect(select('Summary agent').value).toBe('bee'));
 resolveProjectA(Response.json({data:{version:99,defaults:{enabled:true,agentId:'ghost',profileId:'ghost-profile',model:'ghost-model'},agents:[]}}));
 await act(async()=>{await Promise.resolve();});
 expect(select('Summary agent').value).toBe('bee');
 expect(select('Summary execution').value).toBe('false');
 expect(screen.queryByRole('option',{name:/ghost/i})).toBeNull();
});

it('clears an already loaded private draft before the next project finishes loading',async()=>{
 let resolveProjectB!:(response:Response)=>void;
 const delayedProjectB=new Promise<Response>(resolve=>{resolveProjectB=resolve;});
 const privateSettings={version:2,defaults:{enabled:false,agentId:'private-agent-a',profileId:'private-profile-a',model:'private-model-a'},agents:[{id:'private-agent-a',online:true,available:true,capacity:1,busy:0,profiles:[{id:'private-profile-a',models:['private-model-a']}]}]};
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo)=>String(input).includes('/projects/a/')?Response.json({data:privateSettings}):delayedProjectB));
 const view=render(<SummaryExecutionSettings projectId="a" onChanged={async()=>{}}/>);
 await waitFor(()=>expect(select('Summary model').value).toBe('private-model-a'));
 view.rerender(<SummaryExecutionSettings projectId="b" onChanged={async()=>{}}/>);
 expect(screen.queryByDisplayValue('private-model-a')).toBeNull();
 expect(screen.queryByDisplayValue('private-agent-a')).toBeNull();
 await act(async()=>{resolveProjectB(Response.json({data:{version:3,defaults:{enabled:false,agentId:'runner',profileId:'omp-work',model:'small'},agents}}));});
 await waitFor(()=>expect(select('Summary model').value).toBe('small'));
});

it('cannot restore a previous project through its delayed save response',async()=>{
 let resolveSave!:(response:Response)=>void;
 const delayedSave=new Promise<Response>(resolve=>{resolveSave=resolve;});
 const projectA={version:2,defaults:{enabled:false,agentId:'private-agent-a',profileId:'private-profile-a',model:'private-model-a'},agents:[{id:'private-agent-a',online:true,available:true,capacity:1,busy:0,profiles:[{id:'private-profile-a',models:['private-model-a']}]}]};
 const projectB={version:3,defaults:{enabled:false,agentId:'runner',profileId:'omp-work',model:'small'},agents};
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo,init?:RequestInit)=>{
  if(init?.method==='PATCH')return delayedSave;
  return Response.json({data:String(input).includes('/projects/a/')?projectA:projectB});
 }));
 const view=render(<SummaryExecutionSettings projectId="a" onChanged={async()=>{}}/>);
 await waitFor(()=>expect(select('Summary model').value).toBe('private-model-a'));
 await userEvent.click(screen.getByRole('button',{name:'Save summary settings'}));
 expect((screen.getByRole('button',{name:'Save summary settings'}) as HTMLButtonElement).disabled).toBe(true);
 view.rerender(<SummaryExecutionSettings projectId="b" onChanged={async()=>{}}/>);
 await waitFor(()=>expect(select('Summary model').value).toBe('small'));
 await act(async()=>{resolveSave(Response.json({data:{...projectA,version:4}}));});
 expect(select('Summary model').value).toBe('small');
 expect(screen.queryByDisplayValue('private-agent-a')).toBeNull();
});
