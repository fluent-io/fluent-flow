import { z } from 'zod';
import type { PoolClient } from 'pg';
import {getPool} from '../pool.js';
import {authorize} from './authorize.js';
import type {CollabActor} from './auth.js';
import {CollabServiceError} from './errors.js';
import {withClientTransaction} from './tx.js';

const identifier=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const profile=z.object({id:identifier,models:z.array(identifier).max(100),default_model:identifier.optional()}).strict().superRefine((p,ctx)=>{
 if(new Set(p.models).size!==p.models.length || (p.models.length ? !p.default_model||!p.models.includes(p.default_model) : p.default_model!==undefined))ctx.addIssue({code:'custom',message:'Invalid catalog.'});
});
const catalog=z.array(profile).min(1).max(32).superRefine((profiles,ctx)=>{if(new Set(profiles.map(p=>p.id)).size!==profiles.length||Buffer.byteLength(JSON.stringify(profiles))>65536)ctx.addIssue({code:'custom',message:'Invalid catalog.'});});
const actorSchema=z.object({principalId:z.string().uuid(),sessionVersion:z.number().int().positive()}).strict();
const scopeSchema=z.object({actor:actorSchema,projectId:z.string().uuid()}).strict();
export const chatDefaultsSchema=z.object({profileId:identifier.nullable(),model:identifier.nullable(),instructions:z.string().max(20000)}).strict();
const updateSchema=scopeSchema.extend({expectedVersion:z.number().int().positive(),executionMode:z.enum(['chat','connector']),defaultAgentId:z.string().min(1).max(200).nullable(),defaults:chatDefaultsSchema}).strict();
export type ChatAgent={id:string;available:boolean;online:boolean;chatDisabled:boolean;effectiveChatSlots:number|null;profiles:z.infer<typeof profile>[];busyChat:number;busyWork:number;maxChatSlots:number|null};
export type ProjectChatSettings={version:number;executionMode:'chat'|'connector';defaultAgentId:string|null;defaults:z.infer<typeof chatDefaultsSchema>;agents:ChatAgent[]};

export async function readChatAgents(orgId:string,tx:Pick<PoolClient,'query'>=getPool()):Promise<ChatAgent[]> {
 const {rows}=await tx.query(`SELECT a.id,a.max_chat_slots,s.session_meta,s.available,s.session_capacity,
   (SELECT count(*)::int FROM agent_claims c JOIN agent_sessions cs ON cs.id=c.session_id AND cs.org_id=c.org_id WHERE cs.agent_id=a.id AND c.org_id=a.org_id AND c.status='claimed' AND c.claim_type='chat') AS busy_chat,
   (SELECT count(*)::int FROM agent_claims c JOIN agent_sessions cs ON cs.id=c.session_id AND cs.org_id=c.org_id WHERE cs.agent_id=a.id AND c.org_id=a.org_id AND c.status='claimed' AND c.claim_type<>'chat') AS busy_work
  FROM agents a LEFT JOIN LATERAL (
   SELECT session_meta,(expires_at>NOW() AND last_seen_at>NOW()-interval '5 minutes' AND status<>'offline') AS available,
     CASE WHEN jsonb_typeof(session_meta->'capacity')='number'
          AND (session_meta->>'capacity')::numeric BETWEEN 1 AND 16
          AND (session_meta->>'capacity')::numeric % 1 = 0
     THEN (session_meta->>'capacity')::int END AS session_capacity
   FROM agent_sessions WHERE org_id=a.org_id AND agent_id=a.id ORDER BY available DESC NULLS LAST,last_seen_at DESC NULLS LAST,id DESC LIMIT 1
  ) s ON true WHERE a.org_id=$1 AND a.transport='long_poll' ORDER BY a.id`,[orgId]);
 return rows.map(row=>{
  const online=Boolean(row.available);
  const parsed=catalog.safeParse(row.session_meta?.profiles);
  const chatAdvertised=Array.isArray(row.session_meta?.supported_claim_types)&&row.session_meta.supported_claim_types.includes('chat');
  const capacity=online?row.session_capacity??null:null;
  const effectiveChatSlots=row.max_chat_slots===0?0:capacity===null?null:Math.min(row.max_chat_slots??capacity-1,capacity-1);
  const chatDisabled=effectiveChatSlots===0;
  const catalogUsable=chatAdvertised&&parsed.success;
  return {id:row.id,available:Boolean(online&&catalogUsable&&effectiveChatSlots!==null&&effectiveChatSlots>0),online,chatDisabled,effectiveChatSlots,profiles:catalogUsable&&!chatDisabled?parsed.data:[],busyChat:row.busy_chat,busyWork:row.busy_work,maxChatSlots:row.max_chat_slots};
 });
}

export function validateChatSelection(agents:ChatAgent[],agentId:string|null,defaults:z.infer<typeof chatDefaultsSchema>):void {
 if(!agentId){if(defaults.profileId||defaults.model)throw new CollabServiceError(422,'profile_unavailable','Choose an available agent and profile.');return;}
 const agent=agents.find(a=>a.id===agentId);
 if(!agent)throw new CollabServiceError(422,'profile_unavailable','The selected agent is not available.');
 if(agent.chatDisabled)throw new CollabServiceError(422,'profile_unavailable','Chats are disabled on this agent.');
 if(defaults.profileId===null){if(defaults.model)throw new CollabServiceError(422,'profile_unavailable','Choose a profile before choosing a model.');return;}
 const selected=agent.profiles.find(p=>p.id===defaults.profileId);
 if(!selected||(defaults.model!==null&&!selected.models.includes(defaults.model)))throw new CollabServiceError(422,'profile_unavailable','The selected profile or model is no longer available. Reload defaults.');
}

async function read(projectId:string,tx:Pick<PoolClient,'query'>):Promise<ProjectChatSettings>{
 const {rows}=await tx.query(`SELECT p.version,p.execution_mode,p.default_agent_id,p.chat_execution_defaults,w.org_id FROM collab_projects p JOIN collab_workspaces w ON w.id=p.workspace_id WHERE p.id=$1`,[projectId]);
 const row=rows[0];if(!row)throw new CollabServiceError(404,'not_found','Not found.');
 return {version:row.version,executionMode:row.execution_mode,defaultAgentId:row.default_agent_id,defaults:chatDefaultsSchema.parse(row.chat_execution_defaults),agents:row.org_id?await readChatAgents(row.org_id,tx):[]};
}
export async function getProjectChatSettings(input:{actor:CollabActor;projectId:string}):Promise<ProjectChatSettings>{
 const parsed=scopeSchema.parse(input);await authorize(parsed.actor,{projectId:parsed.projectId},['project.admin','internal.read']);return read(parsed.projectId,getPool());
}
export async function updateProjectChatSettings(input:z.infer<typeof updateSchema>):Promise<ProjectChatSettings>{
 const parsed=updateSchema.parse(input);
 return withClientTransaction(async tx=>{
  await authorize(parsed.actor,{projectId:parsed.projectId},['project.admin','internal.read'],tx);
  await tx.query(`SELECT id FROM collab_projects WHERE id=$1 FOR UPDATE`,[parsed.projectId]);
  const current=await read(parsed.projectId,tx);
  if(current.version!==parsed.expectedVersion)throw new CollabServiceError(409,'version_conflict','This item changed. Reload defaults before saving.',{currentVersion:current.version});
  validateChatSelection(current.agents,parsed.defaultAgentId,parsed.defaults);
  await tx.query(`UPDATE collab_projects SET execution_mode=$2,default_agent_id=$3,chat_execution_defaults=$4,version=version+1,updated_at=NOW() WHERE id=$1`,[parsed.projectId,parsed.executionMode,parsed.defaultAgentId,JSON.stringify(parsed.defaults)]);
  return read(parsed.projectId,tx);
 });
}
