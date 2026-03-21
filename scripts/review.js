import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

/**
 * Run code review using Claude.
 * @param {object} options
 * @param {string} options.diff - PR diff
 * @param {object} options.prMeta - PR metadata
 * @param {number} options.attempt - Review attempt number
 * @param {Array} options.priorIssues - Issues from prior attempts
 * @param {string} options.systemPrompt - System prompt for Claude
 * @returns {Promise<object>} Review result
 */
export async function reviewPR({ diff, prMeta, attempt, priorIssues, systemPrompt }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let userContent = 'PR Title: ' + process.env.PR_TITLE + '\n' +
                    'Attempt: ' + attempt;

  if (priorIssues.length > 0) {
    userContent += '\n\nPrior review flagged these issues (check if addressed):\n' +
                   JSON.stringify(priorIssues, null, 2);
  }

  userContent += '\n\nChanged files: ' + (prMeta.files?.map(f => f.path).join(', ') || 'unknown') +
                 '\n\nDiff:\n```diff\n' + diff + '\n```';

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });

    const responseText = message.content[0].text.trim();

    let result;
    try {
      const clean = responseText.replace(/^```json?\n?/i, '').replace(/\n?```$/, '');
      result = JSON.parse(clean);
    } catch (parseErr) {
      console.error('Failed to parse Claude response as JSON:', responseText);
      result = {
        status: 'FAIL',
        summary: 'Review parsing failed — manual review required',
        blocking: [{ file: 'unknown', line: 0, issue: 'Automated review failed to parse', fix: 'Manual review required' }],
        advisory: [],
      };
    }

    result.attempt = attempt;
    result.blocking = result.blocking || [];
    result.advisory = result.advisory || [];

    return result;
  } catch (err) {
    console.error('Claude API error:', err.message);
    throw err;
  }
}