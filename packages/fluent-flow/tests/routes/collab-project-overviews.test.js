import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';

vi.mock('../../src/tracing.cjs',()=>({}));
vi.mock('../../src/logger.js',async()=>{
  const {createMockLogger}=await import('../helpers/mock-logger.js');
  return {default:createMockLogger()};
});
const {resolveCollabTestDatabaseUrl,resetCollabSchema,seedUser,seedOrgMembership}=await import('../helpers/collab-db.js');
process.env.DATABASE_URL=resolveCollabTestDatabaseUrl();
const db=await import('@fluent-flow/db');
const {createApp}=await import('../../src/app.js');
const secret='project-overview-test-0123456789abcdef0123456789abcdef';
const INTERNAL='INTERNAL_CONFIG_DO_NOT_DISCLOSE';
const DTO_KEYS=['boardVersion','description','id','linkedRepoFullName','name','runInstructions','testInstructions','version','workspaceId','workspaceName'];

describe('mounted project overview API',()=>{
  let server,baseUrl,owner,ownerB,workspace,project,sibling,foreign,mapping,host,task,memberIndex=0;
  const actors={};
  const defaults=()=>({mappingId:mapping.id,profileId:'work',model:'work-model',instructions:INTERNAL,summary:{enabled:false,profileId:null,model:null}});
  async function api(method,path,{actor=owner,body}={}){
    const response=await fetch(`${baseUrl}/api/collab/v1${path}`,{method,headers:{'x-fluent-flow-actor':db.signCollaborationActor(actor,secret),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null};
  }
  async function member(name,capabilities,projectId=project.id){
    const role=await api('POST',`/workspaces/${workspace.id}/roles`,{body:{name,capabilities}});
    expect(role.status).toBe(201);
    const invitation=await api('POST',`/projects/${projectId}/invitations`,{body:{email:`overview-${++memberIndex}@example.test`,roleId:role.body.data.id,expiresInHours:24}});
    expect(invitation.status).toBe(201);
    const response=await fetch(`${baseUrl}/api/collab/v1/invitations/accept`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:invitation.body.data.url.split('token=')[1],displayName:name,password:'synthetic overview passphrase'})});
    const accepted=await response.json();
    expect(response.status,JSON.stringify(accepted.error)).toBe(201);
    return {principalId:accepted.data.principal.id,sessionVersion:accepted.data.principal.sessionVersion};
  }
  async function projectRow(id=project.id){
    const {rows}=await db.getPool().query('SELECT name,version,board_version,execution_defaults FROM collab_projects WHERE id=$1',[id]);
    return rows[0];
  }
  async function current(){return (await api('GET',`/projects/${project.id}`)).body.data;}

  beforeAll(async()=>{
    process.env.FF_COLLAB_AUTH_SECRET=secret;
    await resetCollabSchema(process.env.DATABASE_URL);await db.runMigrations();
    const legacy=await seedUser(process.env.DATABASE_URL,{githubId:98771,login:'overview-owner'});
    await seedOrgMembership(process.env.DATABASE_URL,legacy,'overview-org','admin');
    const principal=await db.ensureGithubPrincipal({userId:legacy,displayName:'Overview owner',email:'owner@overview.test'});
    owner={principalId:principal.id,sessionVersion:principal.sessionVersion};
    const legacyB=await seedUser(process.env.DATABASE_URL,{githubId:98772,login:'overview-owner-b'});
    await seedOrgMembership(process.env.DATABASE_URL,legacyB,'overview-org-b','admin');
    const principalB=await db.ensureGithubPrincipal({userId:legacyB,displayName:'Other client owner',email:'owner@other-client.test'});
    ownerB={principalId:principalB.id,sessionVersion:principalB.sessionVersion};
    workspace=await db.bootstrapCollaborationWorkspace({actor:owner,orgId:'overview-org',name:'Overview client',idempotencyKey:'overview-workspace'});
    const workspaceB=await db.bootstrapCollaborationWorkspace({actor:ownerB,orgId:'overview-org-b',name:'Other client',idempotencyKey:'overview-workspace-b'});
    project=await db.createCollabProject({actor:owner,workspaceId:workspace.id,name:'Overview project'});
    sibling=await db.createCollabProject({actor:owner,workspaceId:workspace.id,name:'Sibling private project'});
    foreign=await db.createCollabProject({actor:ownerB,workspaceId:workspaceB.id,name:'Other client project'});
    server=createApp().listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));baseUrl=`http://127.0.0.1:${server.address().port}`;
    host=(await api('POST','/hosts',{body:{name:'Overview PC'}})).body.data;
    const registered=await fetch(`${baseUrl}/api/connector/v1/register`,{method:'POST',headers:{authorization:`Bearer ${host.token}`,'content-type':'application/json'},body:JSON.stringify({instanceId:'overview-fixture',protocolVersion:1,sdkVersion:'0.12.0',catalog:{repositories:[{key:'overview/repo'}],profiles:[{id:'work',name:'Work profile',provider:'fixture',model:'work-model'}]}})});
    expect(registered.status).toBe(200);
    mapping=(await api('POST',`/projects/${project.id}/mappings`,{body:{hostId:host.id,repositoryKey:'overview/repo',profileIds:['work'],defaultProfileId:'work'}})).body.data;
    expect((await api('PATCH',`/projects/${project.id}`,{body:{expectedVersion:1,executionDefaults:defaults()}})).status).toBe(200);
    task=await db.createCollabTask({actor:owner,projectId:project.id,title:'Board task that must not move'});
    actors.viewer=await member('Project viewer',['task.read']);
    actors.writer=await member('Project writer',['task.read','task.write']);
    actors.admin=await member('Project overview admin',['task.read','project.admin']);
  },30000);
  afterAll(async()=>{delete process.env.FF_COLLAB_AUTH_SECRET;if(server)await new Promise(resolve=>server.close(resolve));await db.closePool();});

  it('reads an existing project without an overview row as blank safe fields for any member',async()=>{
    const before=await projectRow();
    for(const actor of [actors.viewer,actors.admin,owner]){
      const response=await api('GET',`/projects/${project.id}`,{actor});
      expect(response.status).toBe(200);
      expect(Object.keys(response.body.data).sort()).toEqual(DTO_KEYS);
      expect(response.body.data).toEqual({id:project.id,workspaceId:workspace.id,workspaceName:'Overview client',name:'Overview project',version:before.version,boardVersion:before.board_version,linkedRepoFullName:null,description:'',runInstructions:'',testInstructions:''});
      const raw=JSON.stringify(response.body);
      for(const secretValue of [INTERNAL,mapping.id,host.id,'work-model'])expect(raw).not.toContain(secretValue);
    }
  });

  it('keeps /me a lightweight catalog without overview text',async()=>{
    const me=await api('GET','/me',{actor:actors.viewer});
    expect(me.status).toBe(200);
    const listed=me.body.data.workspaces.flatMap(item=>item.projects).find(item=>item.id===project.id);
    expect(Object.keys(listed).sort()).toEqual(['boardVersion','executionDefaults','id','linkedRepoFullName','name','version','workspaceId']);
  });

  it('returns 404 for foreign, sibling and unknown projects without revealing them',async()=>{
    const unknown='00000000-0000-4000-8000-000000000000';
    for(const [actor,id] of [[actors.viewer,sibling.id],[owner,foreign.id],[ownerB,project.id],[actors.admin,unknown]]){
      const read=await api('GET',`/projects/${id}`,{actor});
      expect(read.status).toBe(404);expect(read.body.error.code).toBe('not_found');
      const write=await api('PATCH',`/projects/${id}/overview`,{actor,body:{expectedVersion:1,name:'Hijacked'}});
      expect(write.status).toBe(404);expect(write.body.error.code).toBe('not_found');
      expect(JSON.stringify([read.body,write.body])).not.toMatch(/Sibling private|Other client|Overview project/);
    }
    expect((await projectRow(foreign.id)).name).toBe('Other client project');
    expect((await projectRow(sibling.id)).name).toBe('Sibling private project');
  });

  it('refuses edits without project.admin and changes nothing',async()=>{
    const before=await current();
    for(const actor of [actors.viewer,actors.writer]){
      const response=await api('PATCH',`/projects/${project.id}/overview`,{actor,body:{expectedVersion:before.version,name:'Viewer rename',description:'nope'}});
      expect(response.status).toBe(403);expect(response.body.error.code).toBe('forbidden');
    }
    expect(await current()).toEqual(before);
  });

  it('rejects malformed, oversized and versionless bodies with 400 and no partial effects',async()=>{
    const before=await current();
    const rowBefore=await projectRow();
    const bodies=[
      {name:'No version'},
      {expectedVersion:'1',name:'String version'},
      {expectedVersion:before.version},
      {expectedVersion:before.version,name:''},
      {expectedVersion:before.version,name:'x'.repeat(201)},
      {expectedVersion:before.version,name:'Valid name',description:'d'.repeat(20001)},
      {expectedVersion:before.version,runInstructions:'r'.repeat(20001)},
      {expectedVersion:before.version,testInstructions:'t'.repeat(20001)},
      {expectedVersion:before.version,description:null},
      {expectedVersion:before.version,description:42},
      {expectedVersion:before.version,name:'Valid',executionDefaults:defaults()},
    ];
    for(const body of bodies){
      const response=await api('PATCH',`/projects/${project.id}/overview`,{actor:actors.admin,body});
      expect(response.status,JSON.stringify(Object.keys(body))).toBe(400);
      expect(response.body.error.code).toBe('malformed');
    }
    expect((await api('GET','/projects/not-a-uuid',{actor:actors.admin})).status).toBe(400);
    expect(await current()).toEqual(before);
    expect(await projectRow()).toEqual(rowBefore);
  });

  it('saves name and overview atomically, bumps project version only, and reloads for members',async()=>{
    const before=await current();
    const rowBefore=await projectRow();
    const tasksBefore=await db.listCollabTasks({actor:owner,projectId:project.id});
    const body={expectedVersion:before.version,name:'Renamed project',description:'What this project is.\n\n- point','runInstructions':'npm run dev',testInstructions:'t'.repeat(20000)};
    const saved=await api('PATCH',`/projects/${project.id}/overview`,{actor:actors.admin,body});
    expect(saved.status,JSON.stringify(saved.body)).toBe(200);
    const expected={...before,name:'Renamed project',version:before.version+1,description:body.description,runInstructions:'npm run dev',testInstructions:body.testInstructions};
    expect(saved.body.data).toEqual(expected);
    expect((await api('GET',`/projects/${project.id}`,{actor:actors.viewer})).body.data).toEqual(expected);
    const rowAfter=await projectRow();
    expect(rowAfter.board_version).toBe(rowBefore.board_version);
    expect(rowAfter.execution_defaults).toEqual(rowBefore.execution_defaults);
    expect(await db.listCollabTasks({actor:owner,projectId:project.id})).toEqual(tasksBefore);
    expect(tasksBefore.tasks.some(item=>item.id===task.id)).toBe(true);
    const partial=await api('PATCH',`/projects/${project.id}/overview`,{actor:actors.admin,body:{expectedVersion:expected.version,runInstructions:''}});
    expect(partial.status).toBe(200);
    expect(partial.body.data).toEqual({...expected,version:expected.version+1,runInstructions:''});
    const listed=(await api('GET','/me',{actor:actors.viewer})).body.data.workspaces.flatMap(item=>item.projects).find(item=>item.id===project.id);
    expect(listed.name).toBe('Renamed project');expect(listed.version).toBe(expected.version+1);
  });

  it('conflicts on stale versions against execution-default changes without overwriting either side',async()=>{
    const before=await current();
    const defaultsChanged=await api('PATCH',`/projects/${project.id}`,{body:{expectedVersion:before.version,executionDefaults:{...defaults(),instructions:'second defaults'}}});
    expect(defaultsChanged.status).toBe(200);
    expect(Object.keys(defaultsChanged.body.data).sort()).toEqual(['boardVersion','id','linkedRepoFullName','name','version','workspaceId']);
    const stale=await api('PATCH',`/projects/${project.id}/overview`,{actor:actors.admin,body:{expectedVersion:before.version,name:'Stale rename',description:'stale'}});
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(stale.body.error.currentVersion).toBe(before.version+1);
    const afterStale=await current();
    expect(afterStale).toEqual({...before,version:before.version+1});
    expect((await projectRow()).execution_defaults.instructions).toBe('second defaults');

    const overview=await api('PATCH',`/projects/${project.id}/overview`,{actor:actors.admin,body:{expectedVersion:afterStale.version,description:'fresh overview'}});
    expect(overview.status).toBe(200);
    const staleDefaults=await api('PATCH',`/projects/${project.id}`,{body:{expectedVersion:afterStale.version,executionDefaults:{...defaults(),instructions:'stale defaults'}}});
    expect(staleDefaults.status).toBe(409);
    expect((await projectRow()).execution_defaults.instructions).toBe('second defaults');
    expect((await current()).description).toBe('fresh overview');
  });

  it('lets exactly one of two concurrent edits from the same version win',async()=>{
    const before=await current();
    const blocker=await db.getPool().connect();
    let results,pending,committed=false;
    try{
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM collab_projects WHERE id=$1 FOR UPDATE',[project.id]);
      pending=Promise.all(['Concurrent one','Concurrent two'].map(name=>api('PATCH',`/projects/${project.id}/overview`,{actor:actors.admin,body:{expectedVersion:before.version,name,description:name}})));
      const deadline=Date.now()+5000;
      for(;;){
        const {rows}=await db.getPool().query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
        if(rows[0].n>=2)break;
        if(Date.now()>deadline)throw new Error('concurrent edits never blocked on the project row');
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      await blocker.query('COMMIT');
      committed=true;
      results=await pending;
    }finally{
      if(!committed)await blocker.query('ROLLBACK');
      blocker.release();
      if(!committed&&pending)await pending.catch(()=>{});
    }
    expect(results.map(item=>item.status).sort()).toEqual([200,409]);
    const winner=results.find(item=>item.status===200).body.data;
    const after=await current();
    expect(after).toEqual(winner);
    expect(after.version).toBe(before.version+1);
    expect(after.description).toBe(after.name);
  },15000);
});
