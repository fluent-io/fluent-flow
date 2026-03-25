/**
 * MCP command tools (side effects). Each wraps an existing engine function.
 */
import { z } from 'zod';
import yaml from 'js-yaml';
import { executeTransition } from '../../engine/state-machine.js';
import { dispatchReview } from '../../engine/review-manager.js';
import { recordPause, processResume } from '../../engine/pause-manager.js';
import { audit } from '../../db/client.js';
import { getFileExists, createFile } from '../../github/rest.js';
import { invalidateConfig } from '../../config/loader.js';

/**
 * Register all command tools on the MCP server.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerCommandTools(server) {
  server.tool(
    'execute_transition',
    'Execute a state transition for an issue (validates transition rules)',
    {
      owner: z.string(),
      repo: z.string(),
      issue_number: z.number().int(),
      to_state: z.string(),
      agent_id: z.string(),
      context: z.record(z.any()).optional().describe('Requirements context: { assignee, linked_pr, merged_pr, open_pr }'),
      metadata: z.record(z.any()).optional(),
    },
    async ({ owner, repo, issue_number, to_state, agent_id, context, metadata }) => {
      audit('mcp_tool_call', { repo: `${owner}/${repo}`, actor: agent_id, data: { tool: 'execute_transition', issue_number, to_state } });
      try {
        const result = await executeTransition({
          owner, repo, issueNumber: issue_number, toState: to_state,
          triggerType: 'mcp', actor: agent_id, context: context ?? {}, metadata,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, from_state: result.fromState, to_state: result.toState }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message, code: err.code, missing: err.missing }) }], isError: true };
      }
    }
  );

  server.tool(
    'dispatch_review',
    'Trigger an automated code review for a pull request',
    {
      owner: z.string(),
      repo: z.string(),
      pr_number: z.number().int(),
      agent_id: z.string(),
      ref: z.string().optional().default('main'),
    },
    async ({ owner, repo, pr_number, agent_id, ref }) => {
      audit('mcp_tool_call', { repo: `${owner}/${repo}`, actor: agent_id, data: { tool: 'dispatch_review', pr_number } });
      await dispatchReview({ owner, repo, prNumber: pr_number, ref });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message: `Review dispatched for PR #${pr_number}` }) }] };
    }
  );

  server.tool(
    'record_pause',
    'Pause an issue, notifying the team that human attention is needed',
    {
      owner: z.string(),
      repo: z.string(),
      issue_number: z.number().int(),
      reason: z.string().describe('e.g. decision, agent-stuck, external-action, ui-review'),
      agent_id: z.string(),
      pr_number: z.number().int().optional(),
      context: z.string().optional().describe('Human-readable explanation'),
    },
    async ({ owner, repo, issue_number, reason, agent_id, pr_number, context }) => {
      audit('mcp_tool_call', { repo: `${owner}/${repo}`, actor: agent_id, data: { tool: 'record_pause', issue_number, reason } });
      const pause = await recordPause({
        owner, repo, issueNumber: issue_number, prNumber: pr_number,
        reason, context, actor: agent_id, agentId: agent_id,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, pause_id: pause.id }) }] };
    }
  );

  server.tool(
    'process_resume',
    'Resume a paused issue, optionally specifying a target state',
    {
      owner: z.string(),
      repo: z.string(),
      issue_number: z.number().int(),
      agent_id: z.string(),
      to_state: z.string().optional().describe('Target state override'),
      instructions: z.string().optional().describe('Instructions for the agent'),
    },
    async ({ owner, repo, issue_number, agent_id, to_state, instructions }) => {
      audit('mcp_tool_call', { repo: `${owner}/${repo}`, actor: agent_id, data: { tool: 'process_resume', issue_number } });
      try {
        const result = await processResume({
          owner, repo, issueNumber: issue_number,
          toState: to_state, instructions, resumedBy: agent_id, agentId: agent_id,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, target_state: result.targetState }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message, code: err.code }) }], isError: true };
      }
    }
  );

  server.tool(
    'onboard_repo',
    'Onboard a GitHub repository to Fluent Flow by creating config and workflow files',
    {
      owner: z.string(),
      repo: z.string(),
      default_agent: z.string(),
      agent_id: z.string(),
      project_id: z.string().optional(),
    },
    async ({ owner, repo, default_agent, agent_id, project_id }) => {
      audit('mcp_tool_call', { repo: `${owner}/${repo}`, actor: agent_id, data: { tool: 'onboard_repo' } });
      try {
        // Check if either file already exists (GitHub Contents API returns 422 on duplicate)
        const [configExists, workflowExists] = await Promise.all([
          getFileExists(owner, repo, '.github/fluent-flow.yml'),
          getFileExists(owner, repo, '.github/workflows/pr-review.yml'),
        ]);

        if (configExists || workflowExists) {
          const message = configExists && workflowExists
            ? `${owner}/${repo} is already onboarded`
            : configExists
              ? `${owner}/${repo} config already exists`
              : `${owner}/${repo} review workflow already exists`;
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message, code: 'ALREADY_ONBOARDED' }) }],
            isError: true,
          };
        }

        // Build config YAML safely via js-yaml
        const configObj = { default_agent };
        if (project_id) configObj.project_id = project_id;
        const configYaml = yaml.dump(configObj, { lineWidth: -1 });

        // Build workflow YAML (static template, no user input)
        const workflowYaml = [
          'name: PR Review',
          'on:',
          '  workflow_dispatch:',
          '    inputs:',
          '      pr_number:',
          '        required: true',
          '        type: string',
          '      attempt:',
          '        required: false',
          '        type: string',
          '        default: "1"',
          '      prior_issues:',
          '        required: false',
          '        type: string',
          '        default: "[]"',
          '',
          'jobs:',
          '  review:',
          '    uses: fluent-io/fluent-flow/.github/workflows/reusable-review.yml@main',
          '    with:',
          '      pr_number: ${{ inputs.pr_number }}',
          '      attempt: ${{ inputs.attempt }}',
          '      prior_issues: ${{ inputs.prior_issues }}',
          '    secrets:',
          '      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
          '      FLUENT_FLOW_URL: ${{ secrets.FLUENT_FLOW_URL }}',
          '',
        ].join('\n');

        const commitMessage = 'chore: onboard to Fluent Flow';

        // Create both files
        await createFile(owner, repo, '.github/fluent-flow.yml', configYaml, commitMessage);
        await createFile(owner, repo, '.github/workflows/pr-review.yml', workflowYaml, commitMessage);

        // Invalidate config cache so next resolveConfig picks up the new file
        await invalidateConfig(owner, repo);

        console.log({ msg: 'Repo onboarded to Fluent Flow', owner, repo, default_agent });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: true,
              message: `${owner}/${repo} onboarded. Add repo secrets: ANTHROPIC_API_KEY, FLUENT_FLOW_URL`,
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }],
          isError: true,
        };
      }
    }
  );
}
