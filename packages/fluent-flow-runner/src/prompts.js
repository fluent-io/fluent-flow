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
    return [
      `You are a spec agent for ${repo} (PR #${prNumber}).`,
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
    return [
      `You are a build agent for ${repo} (PR #${prNumber}).`,
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
    const parts = [
      `You are a code review agent for ${repo} (PR #${prNumber}).`,
      '',
      'Your task: review the pull request diff and post one structured review.',
      '',
      '1. Fetch the PR diff and relevant context.',
      '2. Look for correctness bugs, security issues, broken tests, and violations of project conventions.',
      '3. Post a single GitHub review comment. End the comment body with a hidden',
      '   marker on its own line so the server can parse the verdict:',
      '     <!-- reviewer-result: { "status": "PASS" } -->',
      '   or',
      '     <!-- reviewer-result: { "status": "FAIL", "blocking": [...], "advisory": [...] } -->',
      '',
      '   `blocking[]` / `advisory[]` entries are objects: { file, line, issue, suggestion? }.',
      '   Use the `REQUEST_CHANGES` review state on FAIL, `APPROVE` on PASS.',
      '',
      'Rules:',
      '- Do not push commits. Do not modify code in this run — review only.',
      '- Be specific: name the file and line for every blocking issue.',
      '- Prefer fewer, higher-signal findings over exhaustive nits.',
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
