// Actual NextAuth -> signed proxy -> mounted createApp -> private PostgreSQL.
// Seed using collab-settings-security.test.js and FF_SETTINGS_BROWSER_FIXTURE_PATH.
import assert from 'node:assert/strict';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
const fixturePath=process.env.FF_SETTINGS_BROWSER_FIXTURE_PATH??'/tmp/ff-b-settings-fixture.json';
assert.equal(statSync(fixturePath).mode&0o077,0,'fixture credentials must be private');
const fixture=JSON.parse(readFileSync(fixturePath,'utf8'));
const origin=process.env.FF_UI_TEST_ORIGIN??'http://127.0.0.1:3100';
const executablePath=process.env.FF_UI_TEST_CHROMIUM_PATH??(existsSync('/opt/google/chrome/chrome')?'/opt/google/chrome/chrome':undefined);
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
const errors=[],requests=[];
async function login(role){
  const context=await browser.newContext();const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/collab/v1'))requests.push({role,path:url.pathname.replace('/api/collab/v1',''),method:request.method()});});
  await page.goto(`${origin}/login?callbackUrl=/settings`);
  await page.getByPlaceholder('Email',{exact:true}).fill(fixture.emails[role]);
  await page.getByPlaceholder('Password',{exact:true}).fill(fixture.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.waitForURL(`${origin}/settings`);
  return {context,page};
}
let page;
try{
  const member=await login('memberAdmin');page=member.page;
  await page.getByRole('combobox',{name:'Settings scope'}).selectOption(`project:${fixture.projectId}`);
  const members=page.getByRole('region',{name:'Members',exact:true});
  await expect(members.getByRole('combobox',{name:'Role for Project membership admin',exact:true})).toBeVisible({timeout:10000});
  assert.equal(await members.getByRole('combobox',{name:'Role for Workspace private staff',exact:true}).count(),0);
  assert.equal(await members.getByRole('combobox',{name:'Role for Sibling private staff',exact:true}).count(),0);
  assert.equal(await page.getByPlaceholder('Custom role name').count(),0);
  assert.equal(await page.getByRole('region',{name:'Execution defaults',exact:true}).count(),0);
  const badReads=requests.filter(item=>item.role==='memberAdmin'&&(item.path==='/hosts'||item.path.endsWith('/mappings')||item.path.startsWith('/projects/')&&item.path.endsWith('/roles')));
  assert.deepEqual(badReads,[],'membership-only settings must not request unrelated execution or nonexistent project-role routes');
  await members.getByRole('combobox',{name:'Invitation role',exact:true}).selectOption({label:'viewer'});
  await members.getByPlaceholder('collaborator@example.com').fill(`browser-${Date.now()}@example.test`);
  await members.getByRole('button',{name:'Create invitation',exact:true}).click();
  await expect(members.getByText('One-time invitation link (copy now, shown once):',{exact:true})).toBeVisible();
  await member.context.close();

  const workspace=await login('workspaceAdmin');page=workspace.page;
  await page.getByRole('combobox',{name:'Settings scope'}).selectOption(`workspace:${fixture.workspaceId}`);
  await expect(page.getByRole('region',{name:'Projects',exact:true}).getByText('Settings project',{exact:true})).toBeVisible();
  assert.equal(await page.getByRole('region',{name:'Projects',exact:true}).getByText('execution not configured',{exact:true}).count(),0,'redacted defaults must not be presented as missing configuration');
  await expect(page.getByRole('region',{name:'Members',exact:true}).getByRole('combobox',{name:'Role for Workspace private staff',exact:true})).toBeVisible();
  const roles=page.getByRole('region',{name:'Roles',exact:true});
  await roles.getByPlaceholder('Custom role name').fill(`Browser viewer ${Date.now()}`);
  await roles.getByRole('button',{name:'Create role',exact:true}).click();
  await expect(roles.getByPlaceholder('Custom role name')).toHaveValue('');
  assert.equal(await page.getByText('Settings could not be loaded for this workspace.',{exact:true}).count(),0);
  await workspace.context.close();

  const config=await login('config');page=config.page;
  await page.getByRole('combobox',{name:'Settings scope'}).selectOption(`project:${fixture.projectId}`);
  const execution=page.getByRole('region',{name:'Execution defaults',exact:true});
  await execution.getByLabel('Enable run summaries',{exact:true}).check();
  await expect(execution.getByLabel('Summary model override',{exact:true})).toHaveValue('summary-model');
  await execution.getByLabel('Default instructions',{exact:true}).fill('Configured offline through actual Settings.');
  const saved=await Promise.all([
    page.waitForResponse(response=>new URL(response.url()).pathname===`/api/collab/v1/projects/${fixture.projectId}`&&response.request().method()==='PATCH'),
    execution.getByRole('button',{name:'Save defaults',exact:true}).click(),
  ]);
  assert.equal(saved[0].status(),200);
  await expect(execution.getByRole('button',{name:'Save defaults',exact:true})).toBeEnabled();
  const me=(await (await page.request.get(`${origin}/api/collab/v1/me`)).json()).data;
  const configured=me.workspaces.flatMap(workspace=>workspace.projects).find(project=>project.id===fixture.projectId).executionDefaults;
  assert.equal(configured.model,'work-model');assert.equal(configured.summary.profileId,'summary');assert.equal(configured.summary.model,'summary-model');
  await execution.getByLabel('Enable run summaries',{exact:true}).uncheck();
  const disabled=await Promise.all([
    page.waitForResponse(response=>new URL(response.url()).pathname===`/api/collab/v1/projects/${fixture.projectId}`&&response.request().method()==='PATCH'),
    execution.getByRole('button',{name:'Save defaults',exact:true}).click(),
  ]);
  assert.equal(disabled[0].status(),200);
  await expect(execution.getByRole('button',{name:'Save defaults',exact:true})).toBeEnabled();
  const disabledMe=(await (await page.request.get(`${origin}/api/collab/v1/me`)).json()).data;
  assert.equal(disabledMe.workspaces.flatMap(workspace=>workspace.projects).find(project=>project.id===fixture.projectId).executionDefaults.summary.enabled,false);
  await page.goto(`${origin}/tasks/${fixture.taskId}`);
  await page.getByRole('button',{name:'Workpad',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Submit for review',exact:true}).count(),0,'internal.read without task.write must not offer delivery mutation');
  await config.context.close();
  const starter=await login('blindStart');page=starter.page;
  await page.goto(`${origin}/tasks/${fixture.taskId}`);
  await page.getByRole('button',{name:'Execution',exact:true}).click();
  await page.getByRole('button',{name:'Start AI work',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Start AI work',exact:true});
  await expect(dialog.getByRole('button',{name:'Queue run',exact:true})).toBeEnabled();
  assert.equal(await dialog.getByRole('combobox').count(),0,'private execution selectors must stay hidden');
  assert.equal(await dialog.getByRole('textbox').count(),0,'private instructions must stay hidden');
  const queued=await Promise.all([
    page.waitForResponse(response=>new URL(response.url()).pathname===`/api/collab/v1/tasks/${fixture.taskId}/runs`&&response.request().method()==='POST'),
    dialog.getByRole('button',{name:'Queue run',exact:true}).click(),
  ]);
  assert.equal(queued[0].status(),202);
  assert.deepEqual(Object.keys(queued[0].request().postDataJSON()),['expectedVersion']);
  const result=(await queued[0].json()).data;
  assert.equal('sessionId' in result,false,'private session identifiers must be absent from generic Start');
  for(const field of ['instructions','profileId','model','mappingId','hostId'])assert.equal(field in result.run,false);
  assert.equal(requests.filter(item=>item.role==='blindStart'&&item.path.endsWith('/mappings')).length,0);
  await starter.context.close();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',scenarios:['actual password sign-in and HMAC proxy','project-only membership admin loads permissible members/roles and invites','workspace-only role creation and project list','no execution requests from membership-only settings','offline configuration preserves distinct work/summary models and disable mode','readonly internal role has no delivery mutation','run.start-only queues configured offline run without private selectors or response fields'],requestCount:requests.length,unhandled:errors}));
}catch(error){
  if(page&&!page.isClosed())await page.screenshot({path:'/tmp/fluent-flow-settings-actual-failure.png',fullPage:true});
  console.error(JSON.stringify({result:'FAIL',message:error.message,unhandled:errors,requests}));throw error;
}finally{await browser.close();}
