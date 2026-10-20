// Real delivery panel with HTTP fixtures; no database or native provider calls.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';

const origin=process.env.FF_UI_TEST_ORIGIN??'http://127.0.0.1:3100';
const id=(digit)=>`${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const taskId=id('1'),projectId=id('2'),principalId=id('4'),deliveryId=id('6');
const timestamp='2026-10-19T12:00:00.000Z';
let mode='history',liveCommit='c'.repeat(40),access='reviewer',decisionRequests=0;
let taskStatus='done',taskVersion=4,postMode='ok';
const postedDecisions=[],savedDecisions=[];
const snapshot=(headCommit,dirty)=>({deliveryId,runId:id('5'),headCommit,dirty,evidenceRevision:'e'.repeat(64)});
const decision=(digit,kind,note,reviewSnapshot,acknowledgedOpenItemIds=[],taskVersion=2)=>({id:id(digit),taskId,decision:kind,note,createdAt:timestamp,decidedByPrincipalId:principalId,taskVersion,deliveryId,acknowledgedOpenItemIds,reviewSnapshot});
const newest=decision('7','accept','Accepted after follow-up',snapshot('b'.repeat(40),false),['criterion:one','question:two'],4);
const reopened=decision('8','reopen','Reopened for follow-up',null,[],3);
const original=decision('9','accept','First acceptance retained',snapshot('a'.repeat(40),true),['check:one']);
const legacy=decision('0','accept',null,null);
const unhandled=[];
const executablePath=process.env.FF_UI_TEST_CHROMIUM_PATH??(existsSync('/opt/google/chrome/chrome')?'/opt/google/chrome/chrome':undefined);
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
const page=await browser.newPage();
page.on('pageerror',error=>unhandled.push(error.message));
await page.route('**/api/auth/session',route=>route.fulfill({json:{user:{id:null,principalId,sessionVersion:1,login:'Fixture reviewer',email:null,image:null,orgs:[],isSuperadmin:false},expires:new Date(Date.now()+3600000).toISOString()}}));
await page.route('**/api/collab/v1/**',async route=>{
  const url=new URL(route.request().url());
  const path=url.pathname.replace('/api/collab/v1','');
  const capabilities=access==='reviewer'?['task.read','delivery.accept']:access==='internal'?['task.read','internal.read']:['task.read'];
  if(path==='/me')return route.fulfill({json:{data:{principal:{id:principalId,displayName:'Fixture reviewer',disabledAt:null,sessionVersion:1},workspaces:[],capabilities:{[projectId]:capabilities}}}});
  if(path===`/tasks/${taskId}`)return route.fulfill({json:{data:{id:taskId,projectId,title:'Decision history regression',description:'Saved task',status:taskStatus,priority:'normal',assigneeId:null,version:taskVersion,position:'1000',blockedReason:null,createdAt:timestamp,updatedAt:timestamp,capabilities,execution:null}}});
  if(path===`/tasks/${taskId}/decisions`){
    if(route.request().method()==='POST'){
      const body=route.request().postDataJSON();postedDecisions.push(body);
      if(postMode!=='ok')return route.fulfill({status:Number(postMode),json:{error:{code:'unavailable',message:postMode==='500'?'Decision temporarily unavailable.':'Decision not available.'}}});
      taskStatus='done';taskVersion++;
      savedDecisions.unshift(decision('d',body.decision,body.note,body.reviewSnapshot,body.acknowledgedOpenItemIds,taskVersion));
      return route.fulfill({json:{data:{decision:body.decision,acknowledged:true}}});
    }
    decisionRequests++;
    if(mode==='unavailable'||/^40[134]$/.test(mode))return route.fulfill({status:mode==='unavailable'?500:Number(mode),json:{error:{code:'unavailable',message:'Private server detail must not be displayed.'}}});
    if(mode==='empty')return route.fulfill({json:{data:[],nextCursor:null}});
    if(url.searchParams.has('cursor'))return route.fulfill({json:{data:[original,legacy,decision('f','cancel','Cancelled before a later delivery',null,[],1)],nextCursor:null}});
    const data=mode==='reaccepted'?[decision('3','accept','Accepted again with unknown worktree',snapshot(null,null),[],6),newest,reopened]:[newest,reopened];
    return route.fulfill({json:{data:[...savedDecisions,...data],nextCursor:reopened.id}});
  }
  if(path===`/tasks/${taskId}/deliveries`)return route.fulfill({json:{data:[{id:deliveryId,taskId,note:'Submitted for review',artifactIds:[],checkEvidenceIds:[],openItemIds:[],createdAt:timestamp,createdBy:principalId}],nextCursor:null}});
  if(path===`/tasks/${taskId}/delivery-review`)return route.fulfill({json:{data:{...snapshot(liveCommit,null),openItems:[]}}});
  if(path===`/tasks/${taskId}/plan`)return route.fulfill({json:{data:{plan:null}}});
  return route.fulfill({json:{data:[],nextCursor:null}});
});
const history=page.getByRole('region',{name:'Decision history',exact:true});
const row=(note)=>history.locator('li').filter({has:page.getByText(note,{exact:true})});
try{
  await page.goto(`${origin}/tasks/${taskId}`);
  await page.getByRole('button',{name:'Workpad',exact:true}).click();
  await expect(history).toBeVisible({timeout:10000});
  await expect(row('First acceptance retained')).toBeVisible();
  await expect(row('Accepted after follow-up')).toContainText(`Reviewed commit: ${'b'.repeat(40)}`);
  await expect(row('Accepted after follow-up')).toContainText('Worktree at decision: clean');
  await expect(row('Accepted after follow-up')).toContainText('Acknowledged open items: 2');
  await expect(row('Accepted after follow-up').locator('time')).toHaveAttribute('datetime',timestamp);
  await expect(row('First acceptance retained')).toContainText(`Reviewed commit: ${'a'.repeat(40)}`);
  await expect(row('First acceptance retained')).toContainText('Worktree at decision: dirty');
  await expect(row('Reopened for follow-up')).toContainText('Reopened');
  await expect(row('Cancelled before a later delivery')).toContainText('Cancelled');
  await expect(history).toContainText('Reviewed snapshot not recorded.');
  assert.equal(await history.getByText(liveCommit,{exact:false}).count(),0,'current HEAD must never replace stored review HEAD');

  taskStatus='review';
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  const decisionNote=page.getByRole('textbox',{name:'Decision note',exact:true});
  await expect(decisionNote).toBeVisible();
  const deliveryNote=page.getByPlaceholder('Delivery note — what changed, what was tested');
  await deliveryNote.fill('Unsubmitted delivery draft stays separate.');
  await decisionNote.fill('Reviewed generated file and checks.\nAccepted with known follow-ups.');
  postMode='500';
  await page.getByRole('button',{name:'Accept (Done)',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'Decision temporarily unavailable.'})).toBeVisible();
  await expect(decisionNote).toHaveValue('Reviewed generated file and checks.\nAccepted with known follow-ups.');
  for(const status of ['401','403','404']){
    postMode=status;
    await decisionNote.fill(`Private decision draft ${status}`);
    await page.getByRole('button',{name:'Accept (Done)',exact:true}).click();
    await expect(decisionNote).toHaveValue('');
  }
  postMode='ok';
  const acceptedNote='Reviewed generated file and checks.\nAccepted with known follow-ups.';
  await decisionNote.fill(acceptedNote);
  await page.getByRole('button',{name:'Accept (Done)',exact:true}).click();
  await expect(decisionNote).toHaveValue('');
  assert.equal(postedDecisions.at(-1).decision,'accept');
  assert.equal(postedDecisions.at(-1).note,acceptedNote,'accept must submit the separate decision note');
  await expect(deliveryNote).toHaveValue('Unsubmitted delivery draft stays separate.');
  await expect(row(acceptedNote)).toBeVisible();

  liveCommit='d'.repeat(40);mode='reaccepted';
  await history.getByRole('button',{name:'Refresh history',exact:true}).click();
  await expect(row('Accepted again with unknown worktree')).toContainText('Reviewed commit: unknown');
  await expect(row('Accepted again with unknown worktree')).toContainText('Worktree at decision: unknown');
  await expect(row('First acceptance retained')).toContainText(`Reviewed commit: ${'a'.repeat(40)}`);
  for(const failure of ['unavailable','401','403','404']){
    mode=failure;
    await history.getByRole('button',{name:'Refresh history',exact:true}).click();
    await expect(history.getByRole('alert')).toHaveText(failure==='unavailable'?'Decision history is temporarily unavailable.':'Decision history is no longer available.');
    assert.equal(await history.getByText('Accepted after follow-up',{exact:true}).count(),0,'failed authorization must not retain private history');
    assert.equal(await history.getByText('No decisions recorded yet.',{exact:true}).count(),0,'failure must not claim empty history');
    mode='history';
    await history.getByRole('button',{name:'Refresh history',exact:true}).click();
    await expect(row('Accepted after follow-up')).toBeVisible();
  }
  mode='empty';
  await history.getByRole('button',{name:'Refresh history',exact:true}).click();
  await expect(history.getByText('No decisions recorded yet.',{exact:true})).toBeVisible();
  access='internal';mode='history';
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByRole('button',{name:'Accept (Done)',exact:true})).toHaveCount(0);
  await history.getByRole('button',{name:'Refresh history',exact:true}).click();
  await expect(row('Accepted after follow-up')).toBeVisible();
  access='none';
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(history).toHaveCount(0);
  const requestCount=decisionRequests;
  await page.waitForTimeout(3400);
  assert.equal(decisionRequests,requestCount,'history polling must stop when its capability is removed');
  assert.deepEqual(unhandled,[]);
  console.log(JSON.stringify({result:'PASS',scenarios:['reviewer/internal-scoped paginated history','before/after acceptance, reopen and cancel retained','stored commit/dirty/unknown and acknowledgment count/date','legacy unknown capture','separate decision note reaches actual POST and readback','note retained on500, cleared on success/401/403/404','unavailable/revoked/empty are distinct','removed capability stops polling'],unhandled}));
}catch(error){
  await page.screenshot({path:'/tmp/fluent-flow-decision-history-failure.png',fullPage:true});
  console.error(JSON.stringify({result:'FAIL',message:error.message,unhandled}));
  throw error;
}finally{await browser.close();}
