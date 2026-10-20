// Real AttentionView and polling; HTTP fixtures only, no database/provider calls.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';

const origin=process.env.FF_UI_TEST_ORIGIN??'http://127.0.0.1:3100';
const taskId='11111111-1111-4111-8111-111111111111';
const principalId='44444444-4444-4444-8444-444444444444';
const item=(index,title=`Activity ${index}`)=>({id:`77777777-7777-4777-8777-${String(index).padStart(12,'0')}`,taskId,projectId:'22222222-2222-4222-8222-222222222222',kind:title.startsWith('Older')?'question':'unread',title,detail:null,createdAt:'2026-10-19T12:00:00.000Z',sessionId:null,requestId:null});
const executablePath=process.env.FF_UI_TEST_CHROMIUM_PATH??(existsSync('/opt/google/chrome/chrome')?'/opt/google/chrome/chrome':undefined);
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
const page=await browser.newPage();
const unhandled=[];
let mode='two-pages';
let attentionRequests=0;
let readEvents=[];
page.on('pageerror',error=>unhandled.push(error.message));
await page.route('**/api/auth/session',route=>route.fulfill({json:{user:{id:null,principalId,sessionVersion:1,login:'Fixture operator',email:null,image:null,orgs:[],isSuperadmin:false},expires:new Date(Date.now()+3600000).toISOString()}}));
await page.route('**/api/collab/v1/**',async route=>{
  const url=new URL(route.request().url());
  const path=url.pathname.replace('/api/collab/v1','');
  if(path==='/me') return route.fulfill({json:{data:{principal:{id:principalId,displayName:'Fixture operator',disabledAt:null,sessionVersion:1},workspaces:[],capabilities:{}}}});
  if(path===`/tasks/${taskId}/read-cursor`){readEvents.push(route.request().postDataJSON().eventId);return route.fulfill({json:{data:{}}});}
  if(path!=='/attention') return route.fulfill({json:{data:[],nextCursor:null}});
  attentionRequests++;
  if(mode==='revoked') return route.fulfill({status:403,json:{error:{code:'forbidden',message:'Unavailable.'}}});
  const cursor=url.searchParams.get('cursor');
  if(mode==='bounded'){
    const index=cursor?Number(cursor):0;
    return route.fulfill({json:{data:[item(index,index===20?'Older pending approval beyond safety bound':`Bounded activity ${index}`)],nextCursor:index<20?String(index+1):null}});
  }
  return route.fulfill({json:{data:cursor?[item(0),item(100,'Older pending question on page two')]:Array.from({length:100},(_,index)=>item(index)),nextCursor:cursor?(mode==='cycle'?'page-2':null):'page-2'}});
});

try{
  await page.goto(`${origin}/attention`);
  await page.getByText('Older pending question on page two',{exact:true}).waitFor({timeout:10000});
  await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
  assert.equal(await page.getByText('Activity 0',{exact:true}).count(),1,'overlapping pages must deduplicate by event ID');
  assert.equal(await page.locator('li').filter({has:page.getByText('Older pending question on page two',{exact:true})}).getByText('Agent question',{exact:true}).count(),1);
  await Promise.all([
    page.waitForResponse(response=>new URL(response.url()).searchParams.get('cursor')==='page-2'),
    page.locator('li').filter({has:page.getByText('Activity 0',{exact:true})}).getByRole('button',{name:'Mark read',exact:true}).click(),
  ]);
  await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
  assert.deepEqual(readEvents,[item(0).id]);

  mode='cycle';attentionRequests=0;
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Some attention items could not be loaded.'}).waitFor();
  assert.equal(attentionRequests,2,'repeated cursor must stop traversal');
  assert.equal(await page.getByText('Activity 0',{exact:true}).count(),1);

  mode='bounded';attentionRequests=0;
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByRole('button',{name:'Load more',exact:true}).waitFor();
  assert.equal(attentionRequests,20,'automatic traversal must remain bounded');
  await page.getByRole('button',{name:'Load more',exact:true}).click();
  await page.getByText('Older pending approval beyond safety bound',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Load more',exact:true}).count(),0);

  mode='revoked';
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Attention access is no longer available.'}).waitFor();
  assert.equal(await page.getByText('Older pending approval beyond safety bound',{exact:true}).count(),0,'revocation must clear prior scoped items');
  assert.equal(await page.getByText('Nothing needs your attention right now.',{exact:true}).count(),0,'failed refresh must not claim an empty inbox');
  assert.deepEqual(unhandled,[]);
  console.log(JSON.stringify({result:'PASS',scenarios:['pending question on second page','overlap dedupe','current mark-read event','cursor cycle guard','bounded traversal with visible load more','revocation clears scoped items'],unhandled}));
}catch(error){
  await page.screenshot({path:'/tmp/fluent-flow-attention-pagination-failure.png',fullPage:true});
  console.error(JSON.stringify({result:'FAIL',message:error.message,unhandled,attentionRequests}));
  throw error;
}finally{await browser.close();}
