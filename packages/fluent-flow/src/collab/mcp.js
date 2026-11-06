import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as db from '@fluent-flow/db';
import logger from '../logger.js';

const uuid=z.string().uuid();
const idempotencyKey=z.string().min(8).max(256);
const text=(value)=>({content:[{type:'text',text:JSON.stringify(value)}]});
const denied=()=>{throw new db.CollabServiceError(403,'forbidden','You do not have permission to perform this action.');};

function serverFor(context) {
  const server=new McpServer({name:'fluent-flow-collaboration',version:'1.0.0'});
  const human=()=>context.kind==='human'?context.actor:denied();
  const agent=(capability)=>context.kind==='agent'&&(!capability||context.capabilities.includes(capability))?context:denied();
  const task=async(taskId)=>{
    if(context.kind==='agent') {
      const own=await db.getAgentReportingTask(context);
      if(taskId&&taskId!==own.id) throw new db.CollabServiceError(404,'not_found','Not found.');
      return own;
    }
    const result=await db.getCollabTask(context.actor,taskId);
    if(result.task.projectId!==context.projectId) throw new db.CollabServiceError(404,'not_found','Not found.');
    return result.task;
  };
  const run=async(runId)=>{
    if(context.kind==='agent') {if(runId!==context.runId) throw new db.CollabServiceError(404,'not_found','Not found.');return db.getAgentReportingTask(context);}
    const result=await db.getCollabRun(context.actor,runId);
    await task(result.run.taskId);
    return result;
  };
  const register=(name,description,schema,callback)=>server.tool(name,description,schema,async(args)=>{
    try {return text(await callback(args));}
    catch(err){
      if(!(err instanceof db.CollabServiceError)&&!(err instanceof z.ZodError)) logger.error({msg:'Collaboration tool failed',tool:name,error:err.message});
      return {...text({error:{code:err instanceof db.CollabServiceError?err.code:'invalid_request',message:err instanceof db.CollabServiceError?err.message:'Unable to complete this request.'}}),isError:true};
    }
  });
  register('collaboration_list_projects','List projects allowed by this credential.',{},async()=>{
    if(context.kind==='agent') {const own=await db.getAgentReportingTask(context);return [{id:own.projectId}];}
    const me=await db.getPrincipalMeProfile(context.actor.principalId);
    return me.workspaces.flatMap(w=>w.projects).filter(p=>p.id===context.projectId);
  });
  register('collaboration_list_tasks','List tasks in the credential project.',{q:z.string().max(200).optional(),cursor:z.string().max(256).optional(),limit:z.number().int().min(1).max(100).optional()},async(args)=>context.kind==='agent'?{tasks:[await task()]}:db.listCollabTasks({...args,actor:human(),projectId:context.projectId}));
  register('collaboration_get_task','Read a task in the credential scope.',{taskId:uuid.optional()},async({taskId})=>task(taskId));
  register('collaboration_create_task','Capture a backlog task without starting work.',{title:z.string().min(1).max(300),description:z.string().max(65535).optional(),priority:db.taskPrioritySchema.optional()},async(args)=>db.createCollabTask({...args,actor:human(),projectId:context.projectId}));
  register('collaboration_update_task','Update a versioned task.',{taskId:uuid,expectedVersion:z.number().int().min(1),title:z.string().min(1).max(300).optional(),description:z.string().max(65535).optional(),priority:db.taskPrioritySchema.optional()},async(args)=>{human();await task(args.taskId);return db.updateCollabTask({...args,actor:human()});});
  register('collaboration_add_comment','Add a discussion update with explicit visibility.',{taskId:uuid,body:z.string().min(1).max(20000),visibility:db.visibilitySchema},async(args)=>{human();await task(args.taskId);return db.createCollabComment({...args,actor:human()});});
  register('collaboration_start_run','Explicitly request AI work.',{taskId:uuid,expectedVersion:z.number().int().min(1),idempotencyKey,mappingId:uuid.optional(),profileId:z.string().max(200).optional(),model:z.string().nullable().optional(),instructions:z.string().max(20000).optional()},async(args)=>{human();await task(args.taskId);return db.startCollabRun({...args,actor:human()});});
  register('collaboration_get_run','Read scoped execution state.',{runId:uuid},async({runId})=>run(runId));
  register('collaboration_send_prompt','Send an authorized follow-up.',{sessionId:uuid,text:z.string().min(1).max(20000),behavior:z.enum(['steer','interrupt']).default('steer'),idempotencyKey},async(args)=>{
    human();
    const {rows}=await db.getPool().query(`SELECT s.run_id FROM collab_sessions s JOIN collab_runs r ON r.id=s.run_id WHERE s.id=$1 AND r.project_id=$2`,[args.sessionId,context.projectId]);
    if(!rows.length) throw new db.CollabServiceError(404,'not_found','Not found.');
    await run(rows[0].run_id);
    return db.submitSessionCommand({actor:human(),sessionId:args.sessionId,idempotencyKey:args.idempotencyKey,command:{kind:'prompt',text:args.text,behavior:args.behavior}});
  });
  const reportContext=async(capability)=>{const scoped=agent(capability);const own=await task();return {taskId:own.id,runId:scoped.runId,sessionId:scoped.sessionId};};
  register('collaboration_report_check','Report a check for the bound run and session; agent provenance is retained.',{checkId:uuid.optional(),name:z.string().min(1).max(200).optional(),command:z.string().max(4000).optional(),status:z.enum(['passed','failed','not_run']),commit:z.string().nullable().default(null),dirty:z.boolean().nullable().optional(),exitCode:z.number().int().nullable().default(null),outputArtifactId:uuid.nullable().optional()},async(args)=>db.recordCollabCheckReport({...args,...await reportContext('report.check'),provenance:'agent'}));
  register('collaboration_add_artifact','Attach an internal artifact to the bound work.',{name:z.string().min(1).max(300),kind:z.enum(['file','url','text']),direction:z.enum(['input','output']).default('output'),reference:z.string().max(2000).nullable().optional(),content:z.string().max(2000000).nullable().optional(),mediaType:z.string().nullable().optional(),sizeBytes:z.number().int().min(0).nullable().optional(),sha256:z.string().nullable().optional()},async(args)=>db.recordCollabArtifactReport({...args,...await reportContext('report.artifact'),provenance:'agent'}));
  register('collaboration_propose_idea','Propose an idea without authorizing execution.',{title:z.string().min(1).max(300),body:z.string().max(20000)},async(args)=>db.recordCollabIdeaReport({...args,...await reportContext('report.idea')}));
  register('collaboration_report_plan','Save the bound session plan.',{items:z.array(z.object({text:z.string().min(1).max(500),status:z.enum(['pending','in_progress','completed'])})).min(1).max(50)},async(args)=>db.recordWorkpadPlanReport({...args,...await reportContext('report.progress')}));
  register('collaboration_report_progress','Report internal progress for the bound work session.',{text:z.string().min(1).max(1000),percent:z.number().min(0).max(100).nullable().default(null)},async(args)=>db.recordAgentProgress(agent('report.progress'),args));
  register('collaboration_report_summary','Save a bound internal summary.',{body:z.string().min(1).max(100000),model:z.string().nullable().default(null),sourceEpoch:z.string().nullable().default(null),sourceSeq:z.string().nullable().default(null)},async(args)=>db.recordCollabSummaryReport({...args,...await reportContext('report.summary'),visibility:'internal'}));
  return server;
}

export async function collabMcpHandler(req,res) {
  let server,transport;
  try {
    const auth=req.headers.authorization;
    if(typeof auth!=='string'||!auth.startsWith('Bearer ')) throw new db.CollabServiceError(401,'unauthenticated','Authentication required.');
    const context=await db.authenticateCollabToken(auth.slice(7));
    server=serverFor(context);
    transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{void transport.close().catch(err=>logger.error({msg:'Collaboration MCP transport close failed',error:err.message}));void server.close().catch(err=>logger.error({msg:'Collaboration MCP server close failed',error:err.message}));});
    await server.connect(transport);
    await transport.handleRequest(req,res,req.body);
  } catch(err) {
    if(!res.headersSent) res.status(err instanceof db.CollabServiceError?err.status:500).json({error:{code:err instanceof db.CollabServiceError?err.code:'internal_error',message:err instanceof db.CollabServiceError?err.message:'Unable to complete this request.'}});
    if(!(err instanceof db.CollabServiceError)) logger.error({msg:'Collaboration MCP failed',error:err.message});
  }
}
