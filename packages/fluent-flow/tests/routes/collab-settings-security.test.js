import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {writeFileSync,chmodSync} from 'node:fs';
import {randomBytes} from 'node:crypto';

vi.mock('../../src/tracing.cjs',()=>({}));
vi.mock('../../src/logger.js',async()=>{
  const {createMockLogger}=await import('../helpers/mock-logger.js');
  return {default:createMockLogger()};
});
const {resolveCollabTestDatabaseUrl,resetCollabSchema,seedLegacyUser,seedLegacyOrgMembership}=await import('../helpers/collab-db.js');
process.env.DATABASE_URL=resolveCollabTestDatabaseUrl();
const db=await import('@fluent-flow/db');
const {createApp}=await import('../../src/app.js');
const secret='settings-security-test-0123456789abcdef0123456789abcdef';

describe('mounted Settings scope and configuration security',()=>{
  let server,baseUrl,owner,workspace,project,sibling,mapping,foreignMapping,host,memberIndex=0;
  const actors={};
  const defaults=()=>({mappingId:mapping.id,profileId:'work',model:'work-model',instructions:'INTERNAL_CONFIG_DO_NOT_DISCLOSE',summary:{enabled:true,profileId:'summary',model:'summary-model'}});
  async function api(method,path,{actor=owner,body}={}){
    const response=await fetch(`${baseUrl}/api/collab/v1${path}`,{method,headers:{'x-fluent-flow-actor':db.signCollaborationActor(actor,secret),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null};
  }
  async function member(name,capabilities,scope='project',projectId=project.id){
    const role=await api('POST',`/workspaces/${workspace.id}/roles`,{body:{name,capabilities}});
    expect(role.status).toBe(201);
    const invitation=await api('POST',scope==='workspace'?`/workspaces/${workspace.id}/invitations`:`/projects/${projectId}/invitations`,{body:{email:`settings-${++memberIndex}@example.test`,roleId:role.body.data.id,expiresInHours:24}});
    expect(invitation.status).toBe(201);
    const response=await fetch(`${baseUrl}/api/collab/v1/invitations/accept`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:invitation.body.data.url.split('token=')[1],displayName:name,password:'synthetic settings passphrase'})});
    const accepted=await response.json();
    expect(response.status,JSON.stringify(accepted.error)).toBe(201);
    const {principal}=accepted.data;
    return {principalId:principal.id,sessionVersion:principal.sessionVersion};
  }
  beforeAll(async()=>{
    process.env.FF_COLLAB_AUTH_SECRET=secret;
    await resetCollabSchema(process.env.DATABASE_URL);await db.runMigrations();
    const legacy=await seedLegacyUser(process.env.DATABASE_URL,{githubId:98761,login:'settings-owner'});
    await seedLegacyOrgMembership(process.env.DATABASE_URL,legacy,'settings-org','admin');
    const principal=await db.ensureGithubPrincipal({legacyUserId:legacy,displayName:'Settings owner',email:'owner@settings.test'});
    owner={principalId:principal.id,sessionVersion:principal.sessionVersion};
    workspace=await db.bootstrapCollaborationWorkspace({actor:owner,legacyOrgId:'settings-org',name:'Settings client',idempotencyKey:'settings-workspace'});
    project=await db.createCollabProject({actor:owner,workspaceId:workspace.id,name:'Settings project'});
    sibling=await db.createCollabProject({actor:owner,workspaceId:workspace.id,name:'Sibling private project'});
    server=createApp().listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));baseUrl=`http://127.0.0.1:${server.address().port}`;
    host=(await api('POST','/hosts',{body:{name:'Offline settings PC'}})).body.data;
    const registered=await fetch(`${baseUrl}/api/connector/v1/register`,{method:'POST',headers:{authorization:`Bearer ${host.token}`,'content-type':'application/json'},body:JSON.stringify({instanceId:'settings-fixture',protocolVersion:1,sdkVersion:'0.12.0',catalog:{repositories:[{key:'settings/repo'},{key:'sibling/repo'}],profiles:[{id:'work',name:'Work profile',provider:'fixture',model:'work-model'},{id:'summary',name:'Summary profile',provider:'fixture',model:'summary-model'}]}})});
    expect(registered.status).toBe(200);
    mapping=(await api('POST',`/projects/${project.id}/mappings`,{body:{hostId:host.id,repositoryKey:'settings/repo',profileIds:['work','summary'],defaultProfileId:'work'}})).body.data;
    foreignMapping=(await api('POST',`/projects/${sibling.id}/mappings`,{body:{hostId:host.id,repositoryKey:'sibling/repo',profileIds:['work'],defaultProfileId:'work'}})).body.data;
    expect((await api('PATCH',`/projects/${project.id}`,{body:{expectedVersion:1,executionDefaults:defaults()}})).status).toBe(200);
    actors.viewer=await member('Project viewer',['task.read']);
    actors.adminOnly=await member('External project admin',['task.read','project.admin']);
    actors.config=await member('Internal configuration admin',['task.read','project.admin','internal.read']);
    actors.memberAdmin=await member('Project membership admin',['task.read','membership.admin']);
    actors.workspaceStaff=await member('Workspace private staff',['task.read'],'workspace');
    actors.siblingStaff=await member('Sibling private staff',['task.read'],'project',sibling.id);
    actors.workspaceAdmin=await member('Workspace membership admin',['task.read','membership.admin'],'workspace');
    actors.blindStart=await member('Private starter',['task.read','run.start']);
    if(process.env.FF_SETTINGS_BROWSER_FIXTURE_PATH){
      const path=process.env.FF_SETTINGS_BROWSER_FIXTURE_PATH;
      if(!path.startsWith('/tmp/'))throw new Error('Browser fixture must stay private in /tmp');
      const task=await db.createCollabTask({actor:owner,projectId:project.id,title:'Private configuration Start fixture'});
      // Internal-only fixture: the genuine legacy org admin signs in through
      // the normal password provider. No public password/linking endpoint.
      const passwordHash=await db.hashPassword('synthetic settings passphrase');
      await db.getPool().query('INSERT INTO collab_password_credentials(principal_id,password_hash) VALUES($1,$2)',[owner.principalId,passwordHash]);
      writeFileSync(path,JSON.stringify({databaseUrl:process.env.DATABASE_URL,authSecret:secret,sessionSecret:randomBytes(32).toString('hex'),workspaceId:workspace.id,projectId:project.id,siblingId:sibling.id,taskId:task.id,password:'synthetic settings passphrase',emails:{memberAdmin:'settings-4@example.test',config:'settings-3@example.test',workspaceAdmin:'settings-7@example.test',blindStart:'settings-8@example.test',legacyAdmin:'owner@settings.test'}}),{mode:0o600});chmodSync(path,0o600);
    }
  },30000);
  afterAll(async()=>{delete process.env.FF_COLLAB_AUTH_SECRET;if(server)await new Promise(resolve=>server.close(resolve));await db.closePool();});

  it('redacts execution defaults from /me and /workspaces unless internal.read is held',async()=>{
    for(const actor of [actors.viewer,actors.adminOnly,actors.memberAdmin]){
      for(const path of ['/me','/workspaces']){
        const response=await api('GET',path,{actor});expect(response.status).toBe(200);
        const workspaces=path==='/me'?response.body.data.workspaces:response.body.data;
        expect(workspaces.flatMap(item=>item.projects).find(item=>item.id===project.id).executionDefaults).toBeNull();
        expect(JSON.stringify(response.body)).not.toContain('INTERNAL_CONFIG_DO_NOT_DISCLOSE');
      }
    }
    const internal=await api('GET','/me',{actor:actors.config});
    expect(internal.body.data.workspaces.flatMap(item=>item.projects).find(item=>item.id===project.id).executionDefaults).toEqual(defaults());
  });

  it('requires internal.read together with project administration for mapping reads and defaults writes',async()=>{
    const externalRead=await api('GET',`/projects/${project.id}/mappings`,{actor:actors.adminOnly});
    expect(externalRead.status).toBe(404);
    const denied=await api('PATCH',`/projects/${project.id}`,{actor:actors.adminOnly,body:{expectedVersion:2,executionDefaults:defaults()}});
    expect(denied.status).toBe(403);
    const internalRead=await api('GET',`/projects/${project.id}/mappings`,{actor:actors.config});
    expect(internalRead.status).toBe(200);expect(internalRead.body.data.map(item=>item.id)).toEqual([mapping.id]);
  });

  it('validates same-project mapping and both profile/model selections while allowing known offline defaults and disabled summaries',async()=>{
    for(const executionDefaults of [
      {...defaults(),mappingId:foreignMapping.id},
      {...defaults(),profileId:'not-in-catalog'},
      {...defaults(),model:'unapproved-model'},
      {...defaults(),summary:{enabled:true,profileId:'not-in-catalog',model:null}},
      {...defaults(),summary:{enabled:true,profileId:'summary',model:'work-model'}},
    ]){
      const response=await api('PATCH',`/projects/${project.id}`,{actor:actors.config,body:{expectedVersion:2,executionDefaults}});
      expect(response.status).toBe(422);
    }
    const malformed=await api('PATCH',`/projects/${project.id}`,{actor:actors.config,body:{expectedVersion:2,executionDefaults:{...defaults(),arbitrary:'ignored-setting'}}});
    expect(malformed.status).toBe(400);
    await db.getPool().query("UPDATE collab_hosts SET last_heartbeat_at=now()-interval '10 minutes' WHERE id=$1",[host.id]);
    const offline=await api('PATCH',`/projects/${project.id}`,{actor:actors.config,body:{expectedVersion:2,executionDefaults:defaults()}});
    expect(offline.status).toBe(200);
    const disabled={...defaults(),summary:{enabled:false,profileId:null,model:null}};
    expect((await api('PATCH',`/projects/${project.id}`,{actor:actors.config,body:{expectedVersion:3,executionDefaults:disabled}})).status).toBe(200);
    expect((await api('PATCH',`/projects/${project.id}`,{actor:actors.config,body:{expectedVersion:4,executionDefaults:defaults()}})).status).toBe(200);
  });

  it('keeps project-only membership administrators from enumerating inherited workspace staff and sibling memberships',async()=>{
    const scoped=await api('GET',`/projects/${project.id}/members`,{actor:actors.memberAdmin});
    expect(scoped.status).toBe(200);
    expect(scoped.body.data.every(member=>member.projectId===project.id)).toBe(true);
    expect(scoped.body.data.map(member=>member.principalId)).not.toContain(actors.workspaceStaff.principalId);
    expect(scoped.body.data.map(member=>member.principalId)).not.toContain(actors.siblingStaff.principalId);
    const ownerList=await api('GET',`/projects/${project.id}/members`);
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.data.map(member=>member.principalId)).toContain(actors.workspaceStaff.principalId);
    expect(ownerList.body.data.map(member=>member.principalId)).not.toContain(actors.siblingStaff.principalId);
    expect((await api('GET',`/workspaces/${workspace.id}/members`,{actor:actors.memberAdmin})).status).toBe(404);
  });

  it('lists only authorized projects through the contracted workspace project route',async()=>{
    const ownerProjects=await api('GET',`/workspaces/${workspace.id}/projects`);
    expect(ownerProjects.status).toBe(200);expect(ownerProjects.body.data.map(item=>item.id).sort()).toEqual([project.id,sibling.id].sort());
    const limited=await api('GET',`/workspaces/${workspace.id}/projects`,{actor:actors.memberAdmin});
    expect(limited.status).toBe(200);expect(limited.body.data.map(item=>item.id)).toEqual([project.id]);
    expect(limited.body.data[0].executionDefaults).toBeNull();
    expect((await api('GET','/workspaces/00000000-0000-4000-8000-000000000001/projects',{actor:actors.memberAdmin})).status).toBe(404);
  });

  it('offers only project-delegable role definitions without workspace membership or role-creation authority',async()=>{
    const roles=await api('GET',`/workspaces/${workspace.id}/roles?projectId=${project.id}`,{actor:actors.memberAdmin});
    expect(roles.status).toBe(200);
    expect(roles.body.data.some(role=>role.name==='viewer')).toBe(true);
    expect(roles.body.data.every(role=>role.capabilities.every(capability=>['task.read','membership.admin'].includes(capability)))).toBe(true);
    expect(roles.body.data.map(role=>role.name)).not.toContain('Internal configuration admin');
    expect((await api('GET',`/workspaces/${workspace.id}/roles?projectId=${sibling.id}`,{actor:actors.memberAdmin})).status).toBe(404);
    expect((await api('GET',`/workspaces/${workspace.id}/roles`,{actor:actors.memberAdmin})).status).toBe(404);
    expect((await api('POST',`/workspaces/${workspace.id}/roles`,{actor:actors.memberAdmin,body:{name:'Forbidden workspace role',capabilities:['task.read']}})).status).toBe(404);
    const viewerRole=roles.body.data.find(role=>role.name==='viewer');
    expect((await api('POST',`/projects/${project.id}/invitations`,{actor:actors.memberAdmin,body:{email:'scoped-invite@example.test',roleId:viewerRole.id,expiresInHours:24}})).status).toBe(201);
  });
});
