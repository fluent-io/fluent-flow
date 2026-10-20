// Actual host administration through password auth, HMAC proxy, createApp and PG.
// Tokens stay in volatile local variables, never logs, screenshots or storage.
import assert from 'node:assert/strict';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
const fixturePath=process.env.FF_SETTINGS_BROWSER_FIXTURE_PATH??'/tmp/ff-b-settings-fixture.json';
assert.equal(statSync(fixturePath).mode&0o077,0,'fixture credentials must be private');
const fixture=JSON.parse(readFileSync(fixturePath,'utf8'));
const origin=process.env.FF_UI_TEST_ORIGIN??'http://127.0.0.1:3100';
const executablePath=process.env.FF_UI_TEST_CHROMIUM_PATH??(existsSync('/opt/google/chrome/chrome')?'/opt/google/chrome/chrome':undefined);
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
const page=await browser.newPage();
let promptValue=null,dialogCount=0,dialogDismissFailed=false,createdHostId=null;
let pageErrors=0;
page.on('pageerror',()=>pageErrors++);
page.on('dialog',async dialog=>{
  dialogCount++;promptValue=dialog.defaultValue();
  try{await dialog.dismiss();}catch{dialogDismissFailed=true;}
});
try{
  await page.goto(`${origin}/login?callbackUrl=/settings`);
  await page.getByPlaceholder('Email',{exact:true}).fill(fixture.emails.legacyAdmin);
  await page.getByPlaceholder('Password',{exact:true}).fill(fixture.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.waitForURL(`${origin}/settings`);
  await page.getByRole('combobox',{name:'Settings scope',exact:true}).selectOption(`project:${fixture.projectId}`);
  const panel=page.getByRole('region',{name:'Hosts and repository mappings',exact:true});
  const hostRow=panel.locator('li').filter({has:page.getByText('Offline settings PC',{exact:true})});
  await expect(hostRow).toBeVisible();
  const hostList=await page.request.get(`${origin}/api/collab/v1/hosts`);
  assert.equal(hostList.status(),200,'authorized host list must succeed');
  const listed=(await hostList.json()).data;
  const observed=listed.find(host=>host.name==='Offline settings PC');
  const heartbeatApiPresent=typeof observed?.lastHeartbeatAt==='string'&&!Number.isNaN(Date.parse(observed.lastHeartbeatAt));
  const rowText=await hostRow.innerText();
  const heartbeatRendered=rowText.includes(' · seen ')&&!rowText.includes('never connected');
  const enroll=panel.getByRole('button',{name:'Enroll execution host',exact:true});
  const [created]=await Promise.all([
    page.waitForResponse(response=>new URL(response.url()).pathname==='/api/collab/v1/hosts'&&response.request().method()==='POST'),
    enroll.click(),
  ]);
  assert.equal(created.status(),201,'host enrollment must succeed');
  const data=(await created.json()).data;createdHostId=data.id;
  const creationTokenPresent=typeof data.token==='string'&&data.token.startsWith('ffh_');
  await expect(enroll).toBeEnabled();
  const enrollmentPromptMatches=creationTokenPresent&&dialogCount===1&&promptValue===data.token&&!dialogDismissFailed;
  const tokenAbsentFromDom=creationTokenPresent&&!(await page.locator('body').innerText()).includes(data.token);
  const tokenAbsentFromStorage=await page.evaluate(token=>![...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>value.includes(token)),data.token);
  const refreshed=(await (await page.request.get(`${origin}/api/collab/v1/hosts`)).json()).data;
  const listIsTokenFree=refreshed.every(host=>!('token' in host)&&!('enrollmentToken' in host));
  console.log(JSON.stringify({heartbeatApiPresent,heartbeatRendered,creationTokenPresent,enrollmentPromptMatches,tokenAbsentFromDom,tokenAbsentFromStorage,listIsTokenFree,pageErrors}));
  assert.equal(heartbeatApiPresent,true,'actual host DTO must expose its observed heartbeat');
  assert.equal(heartbeatRendered,true,'observed host heartbeat must render as seen, not never connected');
  assert.equal(enrollmentPromptMatches,true,'the one-time prompt must show the actual creation token');
  assert.equal(tokenAbsentFromDom&&tokenAbsentFromStorage&&listIsTokenFree,true,'host token must not persist in UI/storage/list responses');
  assert.equal(pageErrors,0,'host settings must have no unhandled page errors');
  console.log(JSON.stringify({result:'PASS',scenarios:['actual legacy-admin password session','required creation token shown exactly once then dismissed','observed heartbeat rendered','token-free list/DOM/storage'],pageErrors}));
}catch(error){
  // No screenshots, response bodies or exception objects: they may contain a
  // one-time token. Boolean assertions above identify the failure safely.
  console.error(JSON.stringify({result:'FAIL',message:error instanceof assert.AssertionError?error.message:'Host browser step failed.',pageErrors}));
  process.exitCode=1;
}finally{
  promptValue=null;
  if(createdHostId){
    try{
      const revoked=await page.request.post(`${origin}/api/collab/v1/hosts/${createdHostId}/revoke`);
      if(revoked.status()!==204){console.error('Synthetic host cleanup failed.');process.exitCode=1;}
    }catch{console.error('Synthetic host cleanup failed.');process.exitCode=1;}
  }
  await browser.close();
}
