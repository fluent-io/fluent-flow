import fs from 'fs';

const PR_NUMBER = process.argv[2];
const ATTEMPT = process.argv[3] || '1';
const RESULT_FILE = process.argv[4] || '/tmp/review_result.json';
const DIFF_FILE = '/tmp/pr.diff';

const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GH_TOKEN;

if (!PR_NUMBER || !REPO || !TOKEN) {
  console.error('Usage: node post-review.mjs <pr_number> <attempt> <result_file>');
  console.error('Required env: GITHUB_REPOSITORY, GH_TOKEN');
  process.exit(1);
}

const result = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
const { status, summary, blocking = [], advisory = [] } = result;

// Read PR metadata for HEAD commit SHA (needed for inline comments)
let commitId = null;
try {
  const prMeta = JSON.parse(fs.readFileSync('/tmp/pr_meta.json', 'utf8'));
  commitId = prMeta.headRefOid ?? null;
} catch {
  // Will be fetched from API if not available locally
}

// Fetch HEAD SHA from API if not in metadata
if (!commitId) {
  try {
    const [owner, repo] = REPO.split('/');
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${PR_NUMBER}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const pr = await res.json();
      commitId = pr.head.sha;
    }
  } catch {
    console.warn('Could not fetch HEAD SHA, inline comments may fail');
  }
}

/**
 * Parse a unified diff to extract which lines are reviewable.
 * Returns a Map of file path → Set of line numbers present in the diff.
 */
function parseDiffLines(diff) {
  const files = new Map();
  let currentFile = null;
  let lineInNew = 0;

  for (const line of diff.split('\n')) {
    // Match file header: +++ b/path/to/file
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!files.has(currentFile)) files.set(currentFile, new Set());
      continue;
    }

    // Match hunk header: @@ -old,count +new,count @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      lineInNew = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (!currentFile) continue;

    // Context or added line — exists in new file
    if (line.startsWith('+') || line.startsWith(' ')) {
      files.get(currentFile).add(lineInNew);
      lineInNew++;
    } else if (line.startsWith('-')) {
      // Deleted line — doesn't exist in new file, don't increment
    }
  }

  return files;
}

/**
 * Find the closest reviewable line in the diff for a given file and target line.
 * Returns the line number if in diff, or the nearest line within 5 lines, or null.
 */
function findReviewableLine(diffLines, file, targetLine) {
  const lines = diffLines.get(file);
  if (!lines) return null;
  if (lines.has(targetLine)) return targetLine;

  // Search nearby lines (within 5 lines)
  for (let offset = 1; offset <= 5; offset++) {
    if (lines.has(targetLine + offset)) return targetLine + offset;
    if (lines.has(targetLine - offset)) return targetLine - offset;
  }

  return null;
}

// Parse diff
let diffLines = new Map();
try {
  const diff = fs.readFileSync(DIFF_FILE, 'utf8');
  diffLines = parseDiffLines(diff);
} catch {
  console.warn('Could not read diff file, all comments will be in review body');
}

// Build inline comments and collect issues that can't be inlined
const inlineComments = [];
const bodyOnlyIssues = [];

for (const issue of blocking) {
  const targetLine = parseInt(issue.line, 10);
  const line = Number.isNaN(targetLine) ? null : findReviewableLine(diffLines, issue.file, targetLine);
  if (line) {
    inlineComments.push({
      path: issue.file,
      line,
      side: 'RIGHT',
      body: `**Blocking:** ${issue.issue}\n\n> **Fix:** ${issue.fix}`,
    });
  } else {
    bodyOnlyIssues.push({ ...issue, severity: 'blocking' });
  }
}

for (const issue of advisory) {
  const targetLine = parseInt(issue.line, 10);
  const line = Number.isNaN(targetLine) ? null : findReviewableLine(diffLines, issue.file, targetLine);
  if (line) {
    inlineComments.push({
      path: issue.file,
      line,
      side: 'RIGHT',
      body: `**Advisory:** ${issue.issue}\n\n> **Suggestion:** ${issue.suggestion}`,
    });
  } else {
    bodyOnlyIssues.push({ ...issue, severity: 'advisory' });
  }
}

// Build review body
const event = status === 'PASS' ? 'APPROVE' : 'REQUEST_CHANGES';
const emoji = status === 'PASS' ? '\u2705' : '\u274c';
const label = status === 'PASS' ? 'PASSED' : 'FAILED';

let body = `## ${emoji} Automated Review: ${label} (Attempt ${ATTEMPT})\n\n`;
body += `**Summary:** ${summary}\n`;
body += `**Blocking issues:** ${blocking.length} | **Advisory notes:** ${advisory.length}`;

if (inlineComments.length > 0) {
  body += `\n\n*${inlineComments.length} issue(s) posted as inline comments.*`;
}

// Add issues that couldn't be posted inline
if (bodyOnlyIssues.length > 0) {
  const blockingBody = bodyOnlyIssues.filter((i) => i.severity === 'blocking');
  const advisoryBody = bodyOnlyIssues.filter((i) => i.severity === 'advisory');

  if (blockingBody.length > 0) {
    body += '\n\n### Blocking Issues (not in diff)\n\n';
    body += blockingBody.map((i) => `- **${i.file}:${i.line}** \u2014 ${i.issue}\n  > Fix: ${i.fix}`).join('\n');
  }
  if (advisoryBody.length > 0) {
    body += '\n\n### Advisory Notes (not in diff)\n\n';
    body += advisoryBody.map((i) => `- **${i.file}:${i.line}** \u2014 ${i.issue}\n  > Suggestion: ${i.suggestion}`).join('\n');
  }
}

// Add machine-readable result
body += `\n\n<!-- reviewer-result: ${JSON.stringify(result)} -->`;

// Post review via GitHub API
const [owner, repo] = REPO.split('/');
const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${PR_NUMBER}/reviews`;

const payload = {
  event,
  body,
  ...(commitId && { commit_id: commitId }),
  comments: inlineComments,
};

try {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`GitHub API error: ${response.status} ${response.statusText}`);
    console.error(errBody);

    // Fallback: post without inline comments if they caused the error
    if (inlineComments.length > 0) {
      console.warn('Retrying without inline comments...');
      const fallbackResponse = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ event, body }),
      });
      if (!fallbackResponse.ok) {
        const fallbackErr = await fallbackResponse.text();
        console.error(`Fallback also failed: ${fallbackResponse.status}`);
        console.error(fallbackErr);
        process.exit(1);
      }
      console.log('Review posted (without inline comments)');
    } else {
      process.exit(1);
    }
  } else {
    const data = await response.json();
    console.log(`Review posted: ${inlineComments.length} inline comments, event=${event}, id=${data.id}`);
  }
} catch (err) {
  console.error('Failed to post review:', err.message);
  process.exit(1);
}
