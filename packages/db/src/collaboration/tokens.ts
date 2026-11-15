import { createHash,randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { getPool } from '../pool.js';
import { authorize } from './authorize.js';
import { requireCurrentPrincipal } from './principals.js';
import { authenticateAgentToken,type AgentReportingContext,type ClaimReportingContext } from './runs.js';
import { authenticateClaimReportingToken, resolveClaimEvidenceAuthority } from './claim-reporting.js';
import { withClientTransaction } from './tx.js';
import { CollabServiceError } from './errors.js';
import { readClaimWorkspaceState } from './claim-workspace-state.js';
import type { CollabActor } from './auth.js';

const hash = (token:string) => createHash('sha256').update(token).digest('hex');
export type CollabTokenContext = AgentReportingContext | {kind:'human';actor:CollabActor;projectId:string;tokenId:string};

export async function createCollabProjectToken(input:{actor:CollabActor;projectId:string;name:string}):Promise<{id:string;token:string;prefix:string}> {
  const parsed = z.object({projectId:z.string().uuid(),name:z.string().trim().min(1).max(100)}).parse(input);
  await authorize(input.actor,{projectId:parsed.projectId},['task.read']);
  const token = `ffcp_${randomBytes(32).toString('base64url')}`;
  const {rows} = await getPool().query(`INSERT INTO collab_project_tokens(principal_id,project_id,name,token_hash,token_prefix,session_version)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[input.actor.principalId,parsed.projectId,parsed.name,hash(token),token.slice(0,12),input.actor.sessionVersion]);
  return {id:rows[0].id,token,prefix:token.slice(0,12)};
}

export async function listCollabProjectTokens(input:{actor:CollabActor;projectId:string}) {
  await authorize(input.actor,{projectId:input.projectId},['task.read']);
  const {rows}=await getPool().query(`SELECT id,name,token_prefix AS prefix,created_at AS "createdAt",revoked_at AS "revokedAt"
    FROM collab_project_tokens WHERE principal_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 100`,[input.actor.principalId,input.projectId]);
  return rows;
}
export async function revokeCollabProjectToken(input:{actor:CollabActor;tokenId:string}):Promise<void> {
  await requireCurrentPrincipal(input.actor);
  const {rowCount}=await getPool().query(`UPDATE collab_project_tokens SET revoked_at=now() WHERE id=$1 AND principal_id=$2`,[input.tokenId,input.actor.principalId]);
  if (!rowCount) throw new CollabServiceError(404,'not_found','Not found.');
}
export async function authenticateCollabToken(token:string):Promise<CollabTokenContext> {
  if(token.startsWith('ffag_')) return authenticateAgentToken(token);
  if(token.startsWith('ffcl_')) return authenticateClaimReportingToken(token);
  const {rows}=await getPool().query(`SELECT id,principal_id,project_id,session_version FROM collab_project_tokens WHERE token_hash=$1 AND revoked_at IS NULL`,[hash(token)]);
  if(!rows.length) throw new CollabServiceError(401,'unauthenticated','Authentication required.');
  const actor={principalId:rows[0].principal_id,sessionVersion:rows[0].session_version};
  await authorize(actor,{projectId:rows[0].project_id},['task.read']);
  return {kind:'human',actor,projectId:rows[0].project_id,tokenId:rows[0].id};
}

function isClaimReportingContext(context:AgentReportingContext):context is ClaimReportingContext {
  return context.source.kind==='claim';
}

export async function getAgentReportingTask(context:AgentReportingContext) {
  if(isClaimReportingContext(context)) {
    if(context.capabilities.includes('report.summary')) {
      const source=context.source;
      return withClientTransaction(async tx=>{
        const authority=await resolveClaimEvidenceAuthority({taskId:context.taskId,claimId:source.claimId,reportingBindingId:source.reportingBindingId},tx);
        if(!authority.capabilities.includes('report.summary')) throw new CollabServiceError(403,'forbidden','You do not have permission to perform this action.');
        const {getClaimSummaryWork}=await import('./summary-claims.js');
        const work=await getClaimSummaryWork({orgId:authority.orgId,claimId:source.claimId},tx);
        return {id:work.taskId,projectId:work.projectId,title:work.taskTitle,reportingRole:'summary',
          summary:{source:work.source,sourceCursor:work.sourceCursor,sourceText:work.sourceText,
            sourceEntryCount:work.sourceEntryCount,sourceTruncated:work.sourceTruncated,profileId:work.profile,model:work.model,reported:work.reported}};
      });
    }
    const {rows}=await getPool().query(`SELECT t.id,t.project_id AS "projectId",t.title,t.description,t.status,t.version,
        claim.status AS "runState",
        jsonb_build_object('claimId',claim.id,'claimType',claim.claim_type,'repository',claim.repo,
          'branch',CASE WHEN claim.claim_type='chat' THEN 'ff/task-'||t.id::text ELSE claim.payload->>'branch' END,
          'prNumber',claim.pr_number) AS execution FROM collab_tasks t
      JOIN collab_claim_executions execution ON execution.task_id=t.id
      JOIN agent_claims claim ON claim.id=execution.claim_id
      WHERE execution.claim_id=$1 AND t.id=$2 AND t.project_id=$3`,[context.source.claimId,context.taskId,context.projectId]);
    if(!rows.length) throw new CollabServiceError(404,'not_found','Not found.');
    const criteria=await getPool().query(`SELECT id,text,state FROM collab_criteria WHERE task_id=$1 ORDER BY created_at LIMIT 100`,[rows[0].id]);
    return {...rows[0],reportingRole:'work',criteria:criteria.rows,workspace:await readClaimWorkspaceState(context.source.reportingBindingId)};
  }
  const {runId,sessionId}=context.source;
  const {rows}=await getPool().query(`SELECT t.id,t.project_id AS "projectId",t.title,t.description,t.status,t.version,
      r.state AS "runState" FROM collab_tasks t JOIN collab_runs r ON r.task_id=t.id
      WHERE r.id=$1 AND r.project_id=$2`,[runId,context.projectId]);
  if(!rows.length) throw new CollabServiceError(404,'not_found','Not found.');
  const criteria=await getPool().query(`SELECT id,text,state FROM collab_criteria WHERE task_id=$1 ORDER BY created_at LIMIT 100`,[rows[0].id]);
  return {...rows[0],criteria:criteria.rows,runId,sessionId};
}

export async function recordAgentProgress(context:AgentReportingContext,input:{text:string;percent:number|null},client?:PoolClient) {
  if(!context.capabilities.includes('report.progress')) throw new CollabServiceError(403,'forbidden','You do not have permission to perform this action.');
  const parsed=z.object({text:z.string().min(1).max(1000),percent:z.number().min(0).max(100).nullable()}).parse(input);
  if(isClaimReportingContext(context)) {
    const source=context.source;
    const taskId=context.taskId;
    const write=async(tx:PoolClient)=>{
      await tx.query('SELECT id FROM collab_tasks WHERE id=$1 FOR UPDATE',[taskId]);
      const authority=await resolveClaimEvidenceAuthority({taskId,claimId:source.claimId,reportingBindingId:source.reportingBindingId},tx);
      if(!authority.capabilities.includes('report.progress')) throw new CollabServiceError(403,'forbidden','You do not have permission to perform this action.');
      const progress={...parsed,provenance:'agent'};
      await tx.query(`INSERT INTO collab_task_events(task_id,project_id,kind,payload,visibility,created_at) VALUES($1,$2,'run_state',$3,'internal',clock_timestamp())`,[authority.taskId,authority.projectId,JSON.stringify({claimId:authority.claimId,progress})]);
      return progress;
    };
    return client?write(client):withClientTransaction(write);
  }
  const {runId,sessionId}=context.source;
  const task=await getAgentReportingTask(context);
  const write=async(tx:PoolClient)=>{
    await tx.query('SELECT id FROM collab_tasks WHERE id=$1 FOR UPDATE',[task.id]);
    const progress={...parsed,provenance:'agent',sessionId};
    await tx.query('UPDATE collab_runs SET progress=$1,updated_at=now() WHERE id=$2 AND project_id=$3',[JSON.stringify(progress),runId,context.projectId]);
    await tx.query(`INSERT INTO collab_task_events(task_id,project_id,kind,payload,visibility,created_at) VALUES($1,$2,'run_state',$3,'internal',clock_timestamp())`,[task.id,context.projectId,JSON.stringify({runId,progress})]);
    return progress;
  };
  return client?write(client):withClientTransaction(write);
}
