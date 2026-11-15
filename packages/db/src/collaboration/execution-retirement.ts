import type { PoolClient } from 'pg';
import { getPool } from '../pool.js';
import { CollabServiceError } from './errors.js';
import { withClientTransaction } from './tx.js';

export async function assertLegacyExecutionOpen(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ frozen_at: Date | null }>(
    'SELECT frozen_at FROM collab_legacy_execution_control WHERE singleton=true FOR SHARE',
  );
  if (rows.length !== 1) throw new CollabServiceError(500, 'configuration_error', 'Execution setup is unavailable. Contact support.');
  if (rows[0].frozen_at !== null) throw new CollabServiceError(409, 'legacy_execution_frozen', 'This execution mode is read-only. Use agent execution instead.');
}

export async function freezeLegacyExecution(): Promise<{ frozenAt: string }> {
  try {
    return await withClientTransaction(async client => {
      const { rows } = await client.query<{ frozenAt: string | null }>(
        `SELECT to_char(frozen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "frozenAt"
         FROM collab_legacy_execution_control WHERE singleton=true FOR UPDATE NOWAIT`,
      );
      if (rows.length !== 1) throw new CollabServiceError(500, 'configuration_error', 'Execution setup is unavailable. Contact support.');
      if (rows[0].frozenAt !== null) return { frozenAt: rows[0].frozenAt };
      const frozen = await client.query<{ frozenAt: string }>(
        `UPDATE collab_legacy_execution_control SET frozen_at=clock_timestamp() WHERE singleton=true
         RETURNING to_char(frozen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "frozenAt"`,
      );
      if (frozen.rows.length !== 1) throw new CollabServiceError(500, 'configuration_error', 'Execution setup is unavailable. Contact support.');
      return frozen.rows[0];
    });
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === '55P03') {
      throw new CollabServiceError(409, 'legacy_execution_busy', 'Execution admissions are busy. No freeze was applied.');
    }
    throw error;
  }
}

type LegacyStateCount = { state: string; count: string };

export interface LegacyExecutionInventory {
  scope: 'server_records_only';
  frozenAt: string | null;
  hosts: { total: string; unrevoked: string };
  mappings: string;
  storedLegacyDefaults: string;
  runs: { unsettled: string; states: LegacyStateCount[] };
  sessions: { unsettled: string; states: LegacyStateCount[] };
  commands: { unsettled: string; states: (LegacyStateCount & { kind: string })[] };
  observations: string;
  legacyTokens: { total: string; unrevoked: string };
  archives: { total: string; sealed: string };
}

export async function readLegacyExecutionInventory(): Promise<LegacyExecutionInventory> {
  const { rows } = await getPool().query<LegacyExecutionInventory>(
    `WITH run_counts AS (SELECT state,count(*) AS total FROM collab_runs GROUP BY state),
     session_counts AS (SELECT state,count(*) AS total FROM collab_sessions GROUP BY state),
     command_counts AS (SELECT state,kind,count(*) AS total FROM collab_connector_commands GROUP BY state,kind)
     SELECT 'server_records_only'::text AS scope,
       to_char(frozen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "frozenAt",
       (SELECT jsonb_build_object('total',count(*)::text,
         'unrevoked',(count(*) FILTER (WHERE revoked_at IS NULL))::text) FROM collab_hosts) AS hosts,
       (SELECT count(*)::text FROM collab_project_host_mappings) AS mappings,
       (SELECT count(*)::text FROM collab_projects WHERE execution_defaults IS NOT NULL
         AND execution_defaults<>'null'::jsonb) AS "storedLegacyDefaults",
       jsonb_build_object(
         'unsettled',(SELECT COALESCE(sum(total) FILTER (WHERE state NOT IN ('failed','cancelled')),0)::text FROM run_counts),
         'states',(SELECT COALESCE(jsonb_agg(jsonb_build_object('state',state,'count',total::text) ORDER BY state),'[]'::jsonb) FROM run_counts)
       ) AS runs,
       jsonb_build_object(
         'unsettled',(SELECT COALESCE(sum(total) FILTER (WHERE state NOT IN ('failed','cancelled')),0)::text FROM session_counts),
         'states',(SELECT COALESCE(jsonb_agg(jsonb_build_object('state',state,'count',total::text) ORDER BY state),'[]'::jsonb) FROM session_counts)
       ) AS sessions,
       jsonb_build_object(
         'unsettled',(SELECT COALESCE(sum(total) FILTER (WHERE state NOT IN ('applied','failed','cancelled')),0)::text FROM command_counts),
         'states',(SELECT COALESCE(jsonb_agg(jsonb_build_object('state',state,'kind',kind,'count',total::text) ORDER BY state,kind),'[]'::jsonb) FROM command_counts)
       ) AS commands,
       (SELECT count(*)::text FROM collab_connector_observations) AS observations,
       (SELECT jsonb_build_object('total',count(*)::text,
         'unrevoked',(count(*) FILTER (WHERE revoked_at IS NULL))::text)
         FROM collab_scoped_tokens WHERE claim_id IS NULL) AS "legacyTokens",
       (SELECT jsonb_build_object('total',count(*)::text,
         'sealed',(count(*) FILTER (WHERE sealed_at IS NOT NULL))::text) FROM collab_execution_archives) AS archives
     FROM collab_legacy_execution_control WHERE singleton=true`,
  );
  if (rows.length !== 1) throw new CollabServiceError(500, 'configuration_error', 'Execution setup is unavailable. Contact support.');
  return rows[0];
}
