import {z} from 'zod';
import {getPool} from '../pool.js';
import {withClientTransaction} from './tx.js';
import {authorize} from './authorize.js';
import {requireCurrentPrincipal} from './principals.js';
import {CollabServiceError} from './errors.js';
import type {CollabActor} from './auth.js';

async function requireLinkScope(actor:CollabActor,taskId:string,write=false) {
  const principal=await requireCurrentPrincipal(actor);
  const {rows}=await getPool().query(`SELECT t.project_id,w.legacy_org_id FROM collab_tasks t JOIN collab_projects p ON p.id=t.project_id JOIN collab_workspaces w ON w.id=p.workspace_id WHERE t.id=$1`,[taskId]);
  if(!rows.length||principal.legacyUserId===null) throw new CollabServiceError(404,'not_found','Not found.');
  await authorize(actor,{projectId:rows[0].project_id},write?['task.write','internal.read']:['task.read','internal.read']);
  return {...rows[0],legacyUserId:principal.legacyUserId};
}
async function requireLegacyRepo(scope:{project_id:string;legacy_org_id:string;legacyUserId:number},repo:string) {
  const {rows}=await getPool().query(`SELECT repo.org_id FROM repos repo JOIN users actor ON actor.id=$3
    WHERE repo.repo_full_name=$1 AND repo.org_id=$2
      AND (actor.is_superadmin OR EXISTS(SELECT 1 FROM user_orgs membership WHERE membership.user_id=actor.id AND membership.org_id=repo.org_id))
      AND EXISTS(SELECT 1 FROM collab_project_host_mappings mapping WHERE mapping.project_id=$4 AND mapping.repository_key=repo.repo_full_name)`,[repo,scope.legacy_org_id,scope.legacyUserId,scope.project_id]);
  if(!rows.length) throw new CollabServiceError(404,'not_found','Not found.');
}
function dto(row:Record<string,any>) {
  return {id:row.id,taskId:row.task_id,projectId:row.project_id,repo:row.repo,prNumber:row.pr_number,claimId:row.claim_id===null?null:Number(row.claim_id),createdAt:new Date(row.created_at).toISOString()};
}
export async function createCollabDeliveryLink(input:{actor:CollabActor;taskId:string;repo:string;prNumber?:number|null;claimId?:number|null}) {
  const parsed=z.object({taskId:z.string().uuid(),repo:z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),prNumber:z.number().int().positive().nullable().default(null),claimId:z.number().int().positive().nullable().default(null)}).refine(x=>x.prNumber!==null||x.claimId!==null).parse(input);
  const scope=await requireLinkScope(input.actor,parsed.taskId,true);
  await requireLegacyRepo(scope,parsed.repo);
  return withClientTransaction(async(tx)=>{
    await tx.query('SELECT id FROM collab_tasks WHERE id=$1 FOR UPDATE',[parsed.taskId]);
    let prNumber=parsed.prNumber;
    if(parsed.claimId!==null) {
      const {rows}=await tx.query('SELECT pr_number FROM agent_claims WHERE id=$1 AND org_id=$2 AND repo=$3',[parsed.claimId,scope.legacy_org_id,parsed.repo]);
      if(!rows.length||(prNumber!==null&&rows[0].pr_number!==prNumber)) throw new CollabServiceError(404,'not_found','Not found.');
      prNumber=rows[0].pr_number;
    }
    const existing=await tx.query(`SELECT * FROM collab_delivery_links WHERE task_id=$1 AND repo=$2 AND pr_number IS NOT DISTINCT FROM $3 AND claim_id IS NOT DISTINCT FROM $4`,[parsed.taskId,parsed.repo,prNumber,parsed.claimId===null?null:String(parsed.claimId)]);
    if(existing.rows.length) return dto(existing.rows[0]);
    const {rows}=await tx.query(`INSERT INTO collab_delivery_links(task_id,project_id,repo,pr_number,claim_id,created_by_principal_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[parsed.taskId,scope.project_id,parsed.repo,prNumber,parsed.claimId===null?null:String(parsed.claimId),input.actor.principalId]);
    return dto(rows[0]);
  });
}
export async function listCollabDeliveryLinks(input:{actor:CollabActor;taskId:string}) {
  const taskId=z.string().uuid().parse(input.taskId);
  const scope=await requireLinkScope(input.actor,taskId);
  const {rows}=await getPool().query(`SELECT link.* FROM collab_delivery_links link JOIN repos repo ON repo.repo_full_name=link.repo AND repo.org_id=$2
    JOIN users actor ON actor.id=$3 WHERE link.task_id=$1
      AND (actor.is_superadmin OR EXISTS(SELECT 1 FROM user_orgs m WHERE m.user_id=actor.id AND m.org_id=repo.org_id))
      AND EXISTS(SELECT 1 FROM collab_project_host_mappings mapping WHERE mapping.project_id=link.project_id AND mapping.repository_key=link.repo)
    ORDER BY link.created_at DESC,link.id DESC LIMIT 100`,[taskId,scope.legacy_org_id,scope.legacyUserId]);
  return rows.map(dto);
}
