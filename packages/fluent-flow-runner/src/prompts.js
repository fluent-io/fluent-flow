/**
 * Supported claim types representing pipeline stages.
 * `review` is the initial automated code review; `review_fix` is the
 * follow-up after that review reports issues.
 */
export const CLAIM_TYPES = ['spec', 'build', 'review', 'review_fix', 'test_verify', 'verify'];

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

  review_fix({ repo, prNumber, message, branch, findings = [], immutability = [], source_claim_id: sourceClaimIdSnake, sourceClaimId }) {
    const hasFindings = Array.isArray(findings) && findings.length > 0;
    const pinnedFiles = Array.isArray(immutability) ? immutability.filter(Boolean) : [];
    const hasPinnedFiles = pinnedFiles.length > 0;
    const sourceClaimIdValue = sourceClaimIdSnake ?? sourceClaimId;
    const parts = [
      `You are a fix agent for ${repo} (PR #${prNumber}).`,
      '',
      'The automated code review found issues that need to be fixed.',
    ];
    if (message) {
      parts.push('', 'Review feedback:', message);
    }
    if (sourceClaimIdValue != null) {
      parts.push('', `Source verify claim: ${sourceClaimIdValue}`);
    }
    if (hasFindings) {
      parts.push('', 'Blocking findings JSON:', JSON.stringify(findings, null, 2));
    }
    if (hasPinnedFiles) {
      parts.push(
        '',
        'Pinned verifier files are immutable:',
        ...pinnedFiles.map((file) => `- ${file}`),
        '',
        'Do not create, modify, rename, or delete tests or framework files that can affect the pinned verifier artifacts. The green verifier treats those changes as tampering.',
      );
    }
    parts.push(
      '',
      'Your task:',
      '1. Fix each issue identified in the review.',
      hasPinnedFiles
        ? '2. Use the existing pinned verifier tests as the behavioral contract; do not add or edit verifier tests.'
        : '2. Add tests that verify the fixes.',
      '3. Ensure all existing and relevant tests pass.',
      '4. Commit your changes with a descriptive message.',
    );
    if (branch) {
      // The runner executes in a `git worktree` checked out at a detached
      // HEAD of the PR branch — a plain `git push` fails there. Without an
      // explicit push the fix never lands and the re-review loops on the
      // same SHA.
      parts.push(
        `5. Push your commits to the PR branch. You are on a DETACHED HEAD checkout — a plain \`git push\` will fail. Push explicitly:`,
        '   ```',
        `   git push origin HEAD:${branch}`,
        '   ```',
      );
    } else {
      parts.push('5. Push your commits to the PR branch (git push origin HEAD:<pr-branch>).');
    }
    parts.push(
      '',
      'Rules:',
      '- Address every blocking issue',
      hasPinnedFiles ? '- Do not alter pinned verifier tests, dependency files, lockfiles, or framework config' : '- Write tests first (TDD)',
      '- Do not modify unrelated code',
      '- The task is only complete when your commits are pushed',
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

  verify(work) {
    const data = work.payload && typeof work.payload === 'object'
      ? { ...work.payload, ...work }
      : work;
    const prNumber = data.prNumber ?? data.pr_number;
    const phase = data.phase ?? 'red';
    const verification = data.verification ?? {};
    const findings = Array.isArray(data.findings) ? data.findings : [];
    const issueNumber = data.issueNumber ?? data.issue_number;
    const framework = verification.framework ?? 'auto';
    const maxRequirements = verification.authoring?.max_requirements ?? 25;
    const frameworkHints = {
      auto: 'Auto-detect the existing repo test framework. Prefer the nearest supported framework already present in this repo.',
      vitest: 'Use Vitest conventions and keep files under the repo test directories for the detected package root.',
      jest: 'Use Jest conventions and keep files under the repo test directories for the detected package root.',
      node: 'Use node:test conventions and keep files under the repo test directories for the detected package root.',
      custom: 'Do not invent commands. Only author manifest/spec/tests for the configured custom framework.',
    };

    return [
      `You are the deterministic verification author for ${data.repo} (PR #${prNumber}).`,
      '',
      `Phase: ${phase}.`,
      'Your only job is to author red-phase verification artifacts against the current broken tree.',
      'DO NOT read any fix — author against the current (broken) state only.',
      '',
      'Inputs:',
      `- Framework target: ${framework}`,
      `- Framework guidance: ${frameworkHints[framework] ?? frameworkHints.auto}`,
      `- max_requirements: ${maxRequirements}`,
      `- PR body: ${data.pr_body ?? data.prBody ?? '(none provided)'}`,
      `- Linked issue: ${issueNumber != null ? `issue #${issueNumber}` : '(none provided)'}`,
      '- Findings JSON with stable IDs:',
      JSON.stringify(findings, null, 2),
      '',
      'Output files:',
      `- .fluent-flow/verify/PR-${prNumber}/red-${data.claim_id ?? data.claimId ?? 'CLAIM_ID'}/spec.md`,
      `- .fluent-flow/verify/PR-${prNumber}/red-${data.claim_id ?? data.claimId ?? 'CLAIM_ID'}/manifest.json`,
      '- New test files only, under the existing repo test directories for the detected package root',
      '',
      'EARS requirements:',
      '- Use EARS sentence forms: ubiquitous, when, while, if, where.',
      '- spec.md must be an intent-only distillation. Do not quote findings verbatim.',
      '- Do not include credentials, secrets, or config identifiers beyond repo-relative test names.',
      '',
      'Manifest contract:',
      '- repo-relative POSIX paths only',
      '- no commands or shell snippets anywhere',
      '- every requirement must map to at least one new test path',
      '- every blocking finding must map to at least one requirement via source_finding_id',
      '- dependency_files may include only repo-relative helper/fixture/config files actually used by the new tests',
      '- framework must be one of vitest, jest, node, or custom',
      '',
      'Authoring limits:',
      '- Create only new files for tests/spec/manifest.',
      '- Keep tests focused on observable behavior implied by the findings.',
      '- Prefer the repo’s existing conventions, helpers, and file naming patterns.',
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
