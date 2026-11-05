import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import { chromium } from '@playwright/test';

const origin=process.env.FF_UI_TEST_ORIGIN??'http://127.0.0.1:3100';
const ids={task:'11111111-1111-4111-8111-111111111111',project:'22222222-2222-4222-8222-222222222222',workspace:'33333333-3333-4333-8333-333333333333',principal:'44444444-4444-4444-8444-444444444444',run:'55555555-5555-4555-8555-555555555555',session:'66666666-6666-4666-8666-666666666666'};
const timestamp=new Date().toISOString();
const capabilities=['task.read','task.write','internal.read','run.start','run.steer','run.cancel'];
const run={id:ids.run,taskId:ids.task,projectId:ids.project,hostId:ids.workspace,mappingId:ids.workspace,profileId:'fixture',model:null,instructions:'',state:'idle',stage:'development',version:1,workspaceId:'wks_fixture',lastObservedAt:timestamp,headCommit:'a'.repeat(40),createdAt:timestamp,updatedAt:timestamp,hostName:'Fixture PC',hostReachability:'online',hostLastSeenAt:timestamp};
const task={id:ids.task,projectId:ids.project,title:'Run refresh regression',description:'Saved task',status:'in_progress',priority:'normal',assigneeId:null,version:1,position:'1000',blockedReason:null,createdAt:timestamp,updatedAt:timestamp,capabilities,execution:{latestRun:run,hostReachability:'online',progress:null,attentionCount:0}};
const session={id:ids.session,runId:ids.run,role:'work',title:'Work session',state:'idle',lastObservedAt:timestamp,paseoAgentId:null,providerSessionId:null};
const executablePath=process.env.FF_UI_TEST_CHROMIUM_PATH??(existsSync('/opt/google/chrome/chrome')?'/opt/google/chrome/chrome':undefined);
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
const page=await browser.newPage();
const unhandled=[];
page.on('pageerror',error=>unhandled.push(error.message));
let mode='ok';
let requests=0;
const pendingFixture=[
  {requestId:'c'.repeat(32),kind:'question',backend:'codex',generation:2,fingerprint:'e'.repeat(64),promptText:'Paste the token',hostOnly:true,inputSchema:null,expiresAt:null,observedAt:timestamp,
    choices:[{id:'decline',label:'Deny and continue',scope:'once',behavior:'deny'}],questions:[{id:'token',header:'Token',question:'Paste the token',options:null,multiSelect:false,allowOther:true,secret:true}]},
  {requestId:'d'.repeat(32),kind:'permission',backend:'codex',generation:2,fingerprint:'f'.repeat(64),promptText:'Run npm test',hostOnly:false,inputSchema:null,expiresAt:null,observedAt:timestamp,questions:null,
    choices:[{id:'accept',label:'Allow once',scope:'once',behavior:'allow'},{id:'cancel',label:'Deny and stop this turn',scope:'once',behavior:'deny'}]},
];
let pendingNow=[];
let paged=false;
let timelineExtra=[];
const commands=[];
const pagedRequest=i=>i===0
  ?{requestId:'0'.repeat(32),kind:'question',backend:'claude-code',generation:1,fingerprint:'1'.repeat(64),promptText:'First question',hostOnly:false,inputSchema:null,expiresAt:null,observedAt:timestamp,
    choices:[{id:'deny',label:'Deny and continue',scope:'once',behavior:'deny'}],questions:[{id:'q0',header:'First',question:'First question',options:[{id:'o0',label:'Yes',description:null}],multiSelect:false,allowOther:true,secret:false}]}
  :{requestId:i.toString(16).padStart(32,'a'),kind:'permission',backend:'claude-code',generation:1,fingerprint:i.toString(16).padStart(64,'b'),promptText:`Paged approval ${i}`,hostOnly:false,inputSchema:null,expiresAt:null,observedAt:timestamp,questions:null,
    choices:[{id:'allow_once',label:'Allow once',scope:'once',behavior:'allow'},{id:'deny',label:'Deny and continue',scope:'once',behavior:'deny'}]};
await page.route('**/api/auth/session',route=>route.fulfill({json:{user:{id:null,principalId:ids.principal,sessionVersion:1,login:'Fixture operator',email:null,image:null,orgs:[],isSuperadmin:false},expires:new Date(Date.now()+3600000).toISOString()}}));
await page.route('**/api/collab/v1/**',async route=>{
  const url=new URL(route.request().url());
  const path=url.pathname.replace('/api/collab/v1','');
  requests++;
  if(path==='/me') return route.fulfill({json:{data:{principal:{id:ids.principal,displayName:'Fixture operator',email:null,legacyUserId:null,disabledAt:null,sessionVersion:1},workspaces:[{id:ids.workspace,name:'Fixture client',projects:[{id:ids.project,workspaceId:ids.workspace,name:'Fixture project',version:1,boardVersion:1,executionDefaults:null}]}],capabilities:{[ids.project]:capabilities}}}});
  if(mode==='network') return route.abort('failed');
  if(mode==='server'||(mode==='server-runs'&&path===`/tasks/${ids.task}/runs`)) return route.fulfill({status:500,json:{error:{code:'internal_error',message:'Configuration error. Contact support.'}}});
  if(/^40[134]$/.test(mode)&&path!==`/tasks/${ids.task}`&&path!==`/tasks/${ids.task}/criteria`&&path!=='/attention') return route.fulfill({status:Number(mode),json:{error:{code:'not_found',message:'Not found.'}}});
  let data=[];
  let cursor;
  if(path===`/tasks/${ids.task}`) data=task;
  else if(path===`/tasks/${ids.task}/runs`) data=[run];
  else if(path===`/runs/${ids.run}`) data={run,sessions:[session],unresolvedCommands:[]};
  else if(path===`/sessions/${ids.session}/pending-requests`){
    if(!paged) data=pendingNow;
    else{const i=url.searchParams.has('cursor')?Number(url.searchParams.get('cursor').slice(1)):0;return route.fulfill({json:{data:[pagedRequest(i)],nextCursor:i<100?`p${i+1}`:null}});}
  }
  else if(path===`/sessions/${ids.session}/commands`&&route.request().method()==='POST'){commands.push(route.request().postDataJSON());return route.fulfill({status:202,json:{data:{commandId:'77777777-7777-4777-8777-777777777777',created:true}}});}
  else if(path===`/sessions/${ids.session}/timeline`){data=url.searchParams.has('cursor')?timelineExtra:[{eventId:'first-output',kind:'timeline',payload:{text:'Recorded execution output'},observedAt:timestamp}];cursor='fixture-watermark';}
  return route.fulfill({json:{data,nextCursor:null,...(cursor?{cursor}:{})}});
});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const visible=async locator=>{await locator.waitFor({state:'visible',timeout:15000});};
const drafts=async()=>{
  await page.getByRole('textbox',{name:'Session title',exact:true}).fill('Unsaved session title');
  await page.getByRole('textbox',{name:'Session instructions',exact:true}).fill('Unsaved new-session instructions');
  await page.getByPlaceholder('Send a follow-up instruction…').fill('Unsaved follow-up instruction');
};
const retained=async()=>{
  assert.equal(await page.getByRole('textbox',{name:'Session title',exact:true}).inputValue(),'Unsaved session title');
  assert.equal(await page.getByRole('textbox',{name:'Session instructions',exact:true}).inputValue(),'Unsaved new-session instructions');
  assert.equal(await page.getByPlaceholder('Send a follow-up instruction…').inputValue(),'Unsaved follow-up instruction');
  assert.equal(await page.getByLabel('Session timeline').count(),1);
  assert.match(await page.getByLabel('Session timeline').innerText(),/Recorded execution output/);
};
try{
  await page.goto(`${origin}/tasks/${ids.task}`);
  await page.getByRole('button',{name:'Execution',exact:true}).click();
  await visible(page.getByRole('textbox',{name:'Session title',exact:true}));
  await visible(page.getByPlaceholder('Send a follow-up instruction…'));
  await drafts();
  for(const failure of (process.env.FF_UI_TEST_FAILURES??'server-runs,server,network').split(',').filter(Boolean)){
    mode=failure;
    await wait(4200);
    assert.equal(unhandled.length,0,`unhandled error during ${failure}: ${unhandled.join(';')}`);
    await visible(page.getByText(/Execution updates are temporarily unavailable/).first());
    await retained();
    mode='ok';
    await wait(4200);
    assert.equal(await page.getByText(/Execution updates are temporarily unavailable/).count(),0);
    assert.equal(await page.getByText('Configuration error. Contact support.',{exact:true}).count(),0,'stale read error remained after recovery');
    await retained();
  }
  for(const status of (process.env.FF_UI_TEST_REVOKE_STATUSES??'401,403,404').split(',').filter(Boolean)){
    mode=status;
    await wait(4200);
    await visible(page.getByText('Execution access is no longer available.').first());
    assert.equal(await page.getByLabel('Session timeline').count(),0,`private timeline retained after ${status}`);
    assert.equal(await page.getByPlaceholder('Send a follow-up instruction…').count(),0,`private draft retained after ${status}`);
    mode='ok';
    await wait(4200);
    await visible(page.getByPlaceholder('Send a follow-up instruction…'));
    assert.equal(await page.getByPlaceholder('Send a follow-up instruction…').inputValue(),'');
  }
  pendingNow=pendingFixture;
  const hostOnly=page.locator(`[data-request-id="${'c'.repeat(32)}"]`);
  const approval=page.locator(`[data-request-id="${'d'.repeat(32)}"]`);
  await visible(hostOnly);
  await visible(approval);
  assert.match(await hostOnly.innerText(),/Answer this request on the execution host\./);
  assert.equal(await hostOnly.locator('input,textarea,select').count(),0,'host-only request offers a value field');
  assert.deepEqual(await approval.getByRole('button').allInnerTexts(),['Allow once','Deny and stop this turn']);
  await hostOnly.getByRole('button',{name:'Cancel',exact:true}).click();
  await approval.getByRole('button',{name:'Deny and stop this turn',exact:true}).click();
  for(let i=0;i<50&&commands.length<2;i++) await wait(100);
  assert.deepEqual(commands,[
    {kind:'permission',requestId:'c'.repeat(32),generation:2,fingerprint:'e'.repeat(64),response:{behavior:'deny',selectedActionId:'decline'}},
    {kind:'permission',requestId:'d'.repeat(32),generation:2,fingerprint:'f'.repeat(64),response:{behavior:'deny',selectedActionId:'cancel'}},
  ]);
  pendingNow=[];
  await wait(4200);
  assert.equal(await page.locator('[data-request-id]').count(),0,'a resolved request kept its controls');
  timelineExtra=[
    {eventId:'history-legacy',kind:'attention',observedAt:timestamp,payload:{attention:'permission',permissionKind:'tool',requestId:'history-only-request',name:'History only approval',actions:[{id:'approve',label:'Approve'},{id:'reject',label:'Reject'}]}},
    {eventId:'history-native',kind:'attention',observedAt:timestamp,payload:{attention:'permission',kind:'permission',requestId:'history-native-request',nativeRequestId:'history-native-request',choices:[{id:'allow_once',label:'Allow once',behavior:'allow'}],state:'pending'}},
  ];
  for(let i=0;i<60&&!(await page.getByLabel('Session timeline').innerText()).includes('history-native-request');i++) await wait(100);
  const history=await page.getByLabel('Session timeline').innerText();
  assert.match(history,/history-only-request/);
  assert.match(history,/history-native-request/);
  await wait(4200);
  assert.equal(await page.locator('[data-request-id]').count(),0,'answer controls were manufactured from timeline history');
  for(const label of ['Approve','Reject','Allow once','Allow','Deny']) assert.equal(await page.getByRole('button',{name:label,exact:true}).count(),0,`a ${label} action was manufactured from timeline history`);
  paged=true;
  const first=page.locator(`[data-request-id="${'0'.repeat(32)}"]`);
  const last=page.locator(`[data-request-id="${(100).toString(16).padStart(32,'a')}"]`);
  await visible(first);
  await first.getByLabel('Other answer for First question').fill('draft for the first request');
  await last.waitFor({state:'visible',timeout:15000}).catch(()=>{});
  assert.equal(await last.count(),1,'request 101 (past 100 pages) is not reachable');
  assert.equal(await page.locator('[data-request-id]').count(),101);
  await wait(4200);
  await last.getByRole('button',{name:'Allow once',exact:true}).click();
  for(let i=0;i<50&&commands.length<3;i++) await wait(100);
  assert.deepEqual(commands[2],{kind:'permission',requestId:(100).toString(16).padStart(32,'a'),generation:1,fingerprint:(100).toString(16).padStart(64,'b'),response:{behavior:'allow',selectedActionId:'allow_once'}});
  assert.equal(await first.getByLabel('Other answer for First question').inputValue(),'draft for the first request','an earlier draft moved or was lost');
  assert.equal(await page.getByText(/More requests are waiting|could not be loaded/).count(),0);
  assert.equal(unhandled.length,0,unhandled.join(';'));
  console.log(JSON.stringify({result:'PASS',scenarios:['500+network transient retention/recovery','401/403/404 execution revocation and recovery','no unhandled promise rejection','session/follow-up drafts retained while unavailable','every plural pending request renders; host-only has no value field; choices submit their own behavior and exact identity','C2 empty plural list + timeline-only attention: history shown, no manufactured actions','C1 101 underfilled pages: request 101 reachable and answered with its own identity, earlier draft kept'],requests}));
}catch(error){
  await page.screenshot({path:'/tmp/fluent-flow-run-refresh-failure.png',fullPage:true});
  console.error(JSON.stringify({result:'FAIL',unhandled,message:error.message}));
  throw error;
}finally{await browser.close();}
