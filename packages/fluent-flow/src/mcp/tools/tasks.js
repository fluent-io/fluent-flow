import { z } from 'zod';
import { createClaim } from '../../agents/claim-manager.js';
import { audit } from '../../db/client.js';

/**
 * Register task pipeline tools on the MCP server.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerTaskTools(server) {
  server.tool(
    'trigger_task',
    'Create a claim of a specific type (spec, build, review_fix, test_verify) for a PR',
    {
      org_id: z.string().default('self-hosted').describe('Organization ID'),
      repo: z.string().describe('Repository in owner/repo format'),
      pr_number: z.number().int().positive(),
      claim_type: z.enum(['spec', 'build', 'review_fix', 'test_verify']),
      attempt: z.number().int().positive().optional().default(1),
      payload: z.record(z.any()).optional().describe('Optional payload (message, issues, context)'),
    },
    async ({ org_id, repo, pr_number, claim_type, attempt, payload }) => {
      audit('mcp_tool_call', { repo, data: { tool: 'trigger_task', claim_type, pr_number } });
      try {
        const claim = await createClaim({
          orgId: org_id,
          repo,
          prNumber: pr_number,
          attempt,
          claimType: claim_type,
          payload: payload ?? {},
        });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, claim }) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }],
          isError: true,
        };
      }
    }
  );
}
