import { Router } from 'express';
import { z } from 'zod';
import { dispatchReview, handleReviewResult, getRetryRecord } from '../engine/review-manager.js';
import logger from '../logger.js';

const router = Router();

const DispatchSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pr_number: z.number().int().positive(),
  ref: z.string().default('main'),
});

const ReviewResultSchema = z.object({
  repo: z.string().min(1),
  pr_number: z.number().int().positive(),
  issue_number: z.number().int().positive().optional(),
  review_sha: z.string().optional(),
  head_branch: z.string().optional(),
  result: z.object({
    status: z.enum(['PASS', 'FAIL']),
    summary: z.string().optional(),
    blocking: z.array(z.object({
      file: z.string(),
      line: z.number(),
      issue: z.string(),
      fix: z.string().optional(),
    })).default([]),
    advisory: z.array(z.object({
      file: z.string(),
      line: z.number(),
      issue: z.string(),
      suggestion: z.string().optional(),
    })).default([]),
    attempt: z.number().int().positive().default(1),
  }),
});

// POST /api/review/dispatch
router.post('/review/dispatch', async (req, res) => {
  const parsed = DispatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }

  const { owner, repo, pr_number, ref } = parsed.data;

  try {
    await dispatchReview({ owner, repo, prNumber: pr_number, ref });
    res.json({ ok: true, message: `Review dispatched for ${owner}/${repo}#${pr_number}` });
  } catch (err) {
    logger.error({ msg: 'Review dispatch failed', owner, repo, pr_number, error: err.message });
    res.status(500).json({ error: 'Review dispatch failed', detail: err.message });
  }
});

// POST /api/review/result
router.post('/review/result', async (req, res) => {
  const parsed = ReviewResultSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }

  const { repo, pr_number, issue_number, review_sha, head_branch, result } = parsed.data;
  const [owner, repoName] = repo.split('/');

  if (!owner || !repoName) {
    return res.status(400).json({ error: 'repo must be in format owner/repo' });
  }

  try {
    const outcome = await handleReviewResult({
      owner,
      repo: repoName,
      prNumber: pr_number,
      issueNumber: issue_number,
      result,
      reviewSha: review_sha,
      headBranch: head_branch,
    });
    res.json({ ok: true, action: outcome.action });
  } catch (err) {
    logger.error({ msg: 'Review result handling failed', repo, pr_number, error: err.message });
    res.status(500).json({ error: 'Review result handling failed', detail: err.message });
  }
});

// GET /api/review/retries/:owner/:repo/:pr
router.get('/review/retries/:owner/:repo/:pr', async (req, res) => {
  const { owner, repo, pr } = req.params;
  const prNumber = parseInt(pr, 10);
  if (isNaN(prNumber) || prNumber < 1) {
    return res.status(400).json({ error: 'Invalid PR number' });
  }

  try {
    const record = await getRetryRecord(`${owner}/${repo}`, prNumber);
    if (!record) {
      return res.status(404).json({ error: 'No retry record found' });
    }
    res.json({ record });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get retry record', detail: err.message });
  }
});

export default router;
