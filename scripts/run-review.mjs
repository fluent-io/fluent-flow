import { reviewPR } from '/tmp/review.mjs';
import fs from 'fs';

const diff = fs.readFileSync('/tmp/pr.diff', 'utf8');
const prMeta = JSON.parse(fs.readFileSync('/tmp/pr_meta.json', 'utf8'));
const attempt = parseInt(process.env.ATTEMPT || '1', 10);
const priorIssues = JSON.parse(process.env.PRIOR_ISSUES || '[]');
const systemPrompt = fs.readFileSync('/tmp/system_prompt.txt', 'utf8');

try {
  const result = await reviewPR({
    diff,
    prMeta,
    attempt,
    priorIssues,
    systemPrompt,
  });
  fs.writeFileSync('/tmp/review_result.json', JSON.stringify(result, null, 2));
  console.log('Review result:', JSON.stringify(result));
} catch (err) {
  console.error('Review failed:', err.message);
  process.exit(1);
}
