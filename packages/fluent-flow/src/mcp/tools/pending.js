/**
 * MCP get_pending_actions tool — the key polling query.
 * Returns unresolved work items for a specific agent.
 */
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { audit } from '../../db/client.js';
import logger from '../../logger.js';

const { pauses } = schema;

/**
 * Register the get_pending_actions tool on the MCP server.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerPendingTool(server) {
  server.tool(
    'get_pending_actions',
    'Get all unresolved work items for this agent. Poll this to discover review failures, pauses, and resumes that need attention.',
    {
      agent_id: z.string().describe('Your registered agent ID'),
      repo: z.string().optional().describe('Filter to a specific "owner/repo"'),
    },
    async ({ agent_id, repo }) => {
      audit('mcp_tool_call', { actor: agent_id, data: { tool: 'get_pending_actions', repo } });
      const actions = await getPendingActions(agent_id, repo);
      return { content: [{ type: 'text', text: JSON.stringify({ actions }) }] };
    }
  );
}

/**
 * Query pending actions across review_retries and pauses tables.
 * @param {string} agentId
 * @param {string} [repoFilter]
 * @returns {Promise<Array>}
 */
export async function getPendingActions(agentId, repoFilter) {
  // Three-way UNION ALL with cross-table joins + JSONB extraction from
  // config_cache — cleaner as one raw SQL statement than the drizzle query
  // builder, which doesn't express UNION ALL ergonomically.
  const repoFilterRR = repoFilter ? sql`AND rr.repo = ${repoFilter}` : sql``;
  const repoFilterP = repoFilter ? sql`AND p.repo = ${repoFilter}` : sql``;

  const result = await db.execute(sql`
    SELECT 'review_failed' AS action_type,
           rr.repo,
           NULL::int AS issue_number,
           rr.pr_number,
           rr.retry_count,
           rr.last_issues AS detail,
           rr.updated_at AS created_at
    FROM review_retries rr
    JOIN config_cache cc ON cc.repo = rr.repo
    WHERE rr.retry_count > 0
      AND rr.last_issues IS NOT NULL
      AND (cc.config->>'default_agent' = ${agentId} OR cc.config->>'agent_id' = ${agentId})
      ${repoFilterRR}

    UNION ALL

    SELECT 'paused' AS action_type,
           p.repo,
           p.issue_number,
           p.pr_number,
           NULL::int AS retry_count,
           jsonb_build_object('reason', p.reason, 'context', p.context) AS detail,
           p.paused_at AS created_at
    FROM pauses p
    WHERE p.agent_id = ${agentId}
      AND p.resumed_at IS NULL
      ${repoFilterP}

    UNION ALL

    SELECT 'resumed' AS action_type,
           p.repo,
           p.issue_number,
           p.pr_number,
           NULL::int AS retry_count,
           jsonb_build_object('target_state', p.resume_to_state, 'instructions', p.resume_instructions) AS detail,
           p.resumed_at AS created_at
    FROM pauses p
    WHERE p.agent_id = ${agentId}
      AND p.resumed_at IS NOT NULL
      AND p.resume_instructions IS NOT NULL
      AND p.resume_acknowledged_at IS NULL
      ${repoFilterP}

    ORDER BY created_at DESC
  `);

  const rows = result.rows ?? result;

  if (rows.some((r) => r.action_type === 'resumed')) {
    db.execute(sql`
      UPDATE pauses SET resume_acknowledged_at = NOW()
      WHERE agent_id = ${agentId}
        AND resumed_at IS NOT NULL
        AND resume_acknowledged_at IS NULL
    `).catch((err) => logger.error({ msg: 'Failed to acknowledge resumes', error: err.message }));
  }

  return rows;
}
