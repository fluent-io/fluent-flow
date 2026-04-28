/**
 * Supported claim types representing pipeline stages.
 * `review` is the initial automated code review; `review_fix` is the
 * follow-up after that review reports issues.
 */
export const CLAIM_TYPES = ['spec', 'build', 'review', 'review_fix', 'test_verify'];

/**
 * Prompt templates by claim_type.
 * Each receives the work object and returns the prompt string.
 */
const TEMPLATES = {
  spec({ repo, prNumber, message }) {
    const prLabel = prNumber != null ? `PR #${prNumber}` : 'standalone';
    return [
      `You are a spec agent for ${repo} (${prLabel}).`,
      '',
      'Your task is to analyze the requirements and create specification and implementation plan documents.',
      '',
      '1. Analyze the PR description, issue, and any linked context.',
      '2. Create a spec file in docs/specs/ following the project conventions.',
      '3. Create a plan file in docs/plans/ with bite-sized implementation steps.',
      '',
      'Rules:',
      '- Only modify or create files under docs/specs/ and docs/plans/',
      '- Follow existing document patterns in the project',
      '- Be specific and actionable — no placeholders',
      ...(message ? ['', 'Additional context:', message] : []),
    ].join('\n');
  },

  build({ repo, prNumber, message }) {
    const prLabel = prNumber != null ? `PR #${prNumber}` : 'standalone';
    return [
      `You are a build agent for ${repo} (${prLabel}).`,
      '',
      'Your task is to implement code following the spec and plan documents.',
      '',
      '1. Read the spec and plan files in docs/specs/ and docs/plans/.',
      '2. Implement the code changes as described in the plan.',
      '3. Follow TDD: write failing tests first, then implement.',
      '4. Run tests and ensure they pass.',
      '',
      'Rules:',
      '- Follow existing code patterns and conventions in the project',
      '- Follow the plan steps in order',
      '- Commit frequently with clear messages',
      ...(message ? ['', 'Additional context:', message] : []),
    ].join('\n');
  },

  review({ repo, prNumber, priorIssues = [], message }) {
    const [owner, name] = repo.split('/');
    const parts = [
      `You are a code review agent for ${repo} (PR #${prNumber}).`,
      '',
      'Your task: review the pull request diff and post a GitHub review with **inline comments** on specific lines.',
      '',
      '## Setup',
      '',
      'The `gh` CLI is available and pre-authenticated. Use it for all GitHub API calls:',
      '  gh pr diff <number>         — get the PR diff',
      '  gh pr view <number> --json title,body,headRefOid — get PR metadata + head SHA',
      '',
      '## Process',
      '',
      '1. Fetch the PR diff and metadata:',
      '   ```bash',
      `   gh pr diff ${prNumber} > /tmp/diff.txt`,
      `   gh pr view ${prNumber} --json title,body,headRefOid`,
      '   ```',
      '',
      '2. Analyze for correctness bugs, security issues, broken tests, and convention violations.',
      '',
      '3. Post a review with inline comments. Write a JSON file and POST it:',
      '   ```bash',
      '   cat > /tmp/review.json << \'EOF\'\n   {',
      '     "body": "Overall summary here.\n\n<!-- reviewer-result: { \\"status\\": \\"PASS\\" } -->",',
      '     "event": "APPROVE",',
      '     "commit_id": "<head SHA>",',
      '     "comments": [',
      '       {',
      '         "path": "src/some/file.ts",',
      '         "position": 42,',
      '         "body": "This line has a bug because..."',
      '       }',
      '     ]',
      '   }',
      '   EOF',
      `   gh api repos/${owner}/${name}/pulls/${prNumber}/reviews --input /tmp/review.json`,
      '   ```',
      '',
      '   **Key fields:**',
      '   - `event`: "APPROVE" for PASS, "REQUEST_CHANGES" for FAIL, "COMMENT" if neutral',
      '   - `commit_id`: the head SHA from `gh pr view --json headRefOid`',
      '   - `comments[]`: array of inline comments, each with:',
      '     - `path`: file path relative to repo root',
      '     - `position`: **1-based index in the diff hunks** (not the file line number). Count from the first `@@` hunk header. Added, removed, and context lines all count. The hunk header line itself does NOT count.',
      '     - `body`: the review comment text',
      '',
      '   **Finding the position:** Parse the diff. For each hunk `@@ -a,b +c,d @@`, the first changed line is position 1. Increment for each line (added, removed, context). The `@@` line itself is not counted.',
      '',
      '4. The review body MUST end with a hidden verdict marker on its own line:',
      '   ```',
      '   <!-- reviewer-result: { "status": "PASS" } -->',
      '   ```',
      '   or for failures:',
      '   ```',
      '   <!-- reviewer-result: { "status": "FAIL", "blocking": [{"file":"src/x.ts","line":10,"issue":"desc"}], "advisory": [] } -->',
      '   ```',
      '',
      '## Rules',
      '- Do NOT push commits. Do NOT modify code — review only.',
      '- Post **inline comments** on the specific lines with issues, not one big comment.',
      '- The review body should be a brief overall summary (2-3 sentences).',
      '- Be specific: every blocking issue gets its own inline comment on the exact line.',
      '- Prefer fewer, higher-signal findings over exhaustive nits.',
      '- If the PR looks good, APPROVE with a brief summary and no inline comments.',
    ];
    if (priorIssues.length > 0) {
      parts.push(
        '',
        'Prior review findings (the author has since pushed new commits — re-evaluate each against the current diff):',
        ...priorIssues.map((i) => `- ${i.file}:${i.line} — ${i.issue}`),
      );
    }
    if (message) {
      parts.push('', 'Additional context:', message);
    }
    return parts.join('\n');
  },

  review_fix({ repo, prNumber, message }) {
    const parts = [
      `You are a fix agent for ${repo} (PR #${prNumber}).`,
      '',
      'The automated code review found issues that need to be fixed.',
    ];
    if (message) {
      parts.push('', 'Review feedback:', message);
    }
    parts.push(
      '',
      'Your task:',
      '1. Fix each issue identified in the review.',
      '2. Add tests that verify the fixes.',
      '3. Ensure all existing and new tests pass.',
      '',
      'Rules:',
      '- Address every blocking issue',
      '- Write tests first (TDD)',
      '- Do not modify unrelated code',
    );
    return parts.join('\n');
  },

  test_verify({ repo, prNumber, message }) {
    return [
      `You are a test verification agent for ${repo} (PR #${prNumber}).`,
      '',
      'A fix agent has pushed changes. Verify the fixes are adequate.',
      '',
      'Your task:',
      '1. Check that the tests added by the fix agent cover the review findings.',
      '2. Verify test correctness — tests should actually test the behavior.',
      '3. Run the full test suite and confirm everything passes.',
      '4. Report any gaps or issues.',
      '',
      'Rules:',
      '- Focus on test quality, not coverage numbers',
      '- Verify tests would catch the original issue',
      '- Do not modify production code — only suggest test improvements',
      ...(message ? ['', 'Previous review issues:', message] : []),
    ].join('\n');
  },
};

/**
 * Resolve the prompt for a claim based on its type.
 *
 * @param {object} opts
 * @param {string} opts.claimType — one of CLAIM_TYPES
 * @param {object} opts.work — the work payload from the server
 * @returns {string} the formatted prompt
 */
export function resolvePrompt({ claimType, work }) {
  if (!CLAIM_TYPES.includes(claimType)) {
    throw new Error(`unknown claim_type "${claimType}"`);
  }
  return TEMPLATES[claimType](work);
}
