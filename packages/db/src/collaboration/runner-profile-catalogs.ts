import { z } from 'zod';
import type { PoolClient } from 'pg';
import {getPool} from '../pool.js';

const identifier=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const profile=z.object({id:identifier,models:z.array(identifier).max(100),default_model:identifier.optional()}).strict().superRefine((p,ctx)=>{
 if(new Set(p.models).size!==p.models.length || (p.models.length ? !p.default_model||!p.models.includes(p.default_model) : p.default_model!==undefined))ctx.addIssue({code:'custom',message:'Invalid catalog.'});
});
const catalog=z.array(profile).min(1).max(32).superRefine((profiles,ctx)=>{if(new Set(profiles.map(p=>p.id)).size!==profiles.length||Buffer.byteLength(JSON.stringify(profiles))>65536)ctx.addIssue({code:'custom',message:'Invalid catalog.'});});
export type RunnerProfileCatalog={id:string;online:boolean;capacity:number|null;supportedClaimTypes:string[];profiles:z.infer<typeof profile>[];busyChat:number;busyWork:number;maxChatSlots:number|null};

export async function readRunnerProfileCatalogs(orgId:string,tx:Pick<PoolClient,'query'>=getPool()):Promise<RunnerProfileCatalog[]> {
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
  const parsed=catalog.safeParse(row.session_meta?.profiles);
  const supportedClaimTypes=Array.isArray(row.session_meta?.supported_claim_types)?row.session_meta.supported_claim_types.filter((value:unknown):value is string=>typeof value==='string'):[];
  return {id:row.id,online:Boolean(row.available),capacity:row.available?row.session_capacity??null:null,supportedClaimTypes,profiles:parsed.success?parsed.data:[],busyChat:row.busy_chat,busyWork:row.busy_work,maxChatSlots:row.max_chat_slots};
 });
}

