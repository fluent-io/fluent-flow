import { Router } from 'express';
import { z } from 'zod';
import { recordPause, processResume, getActivePause } from '../engine/pause-manager.js';
import logger from '../logger.js';

const router = Router();

const PauseSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  issue_number: z.number().int().positive(),
  pr_number: z.number().int().positive().optional(),
  reason: z.string().min(1),
  context: z.string().optional(),
  actor: z.string().optional(),
});

const ResumeSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  issue_number: z.number().int().positive(),
  to_state: z.string().optional(),
  instructions: z.string().optional(),
  resumed_by: z.string().optional(),
});

// POST /api/pause
router.post('/pause', async (req, res) => {
  const parsed = PauseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }

  const { owner, repo, issue_number, pr_number, reason, context, actor } = parsed.data;

  try {
    const pause = await recordPause({ owner, repo, issueNumber: issue_number, prNumber: pr_number, reason, context, actor });
    res.json({ ok: true, pause });
  } catch (err) {
    logger.error({ msg: 'Pause failed', owner, repo, issue_number, error: err.message });
    res.status(500).json({ error: 'Pause failed', detail: err.message });
  }
});

// POST /api/resume
router.post('/resume', async (req, res) => {
  const parsed = ResumeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }

  const { owner, repo, issue_number, to_state, instructions, resumed_by } = parsed.data;

  try {
    const result = await processResume({
      owner,
      repo,
      issueNumber: issue_number,
      toState: to_state,
      instructions,
      resumedBy: resumed_by,
    });
    res.json({ ok: true, targetState: result.targetState, pause: result.pause });
  } catch (err) {
    if (err.code === 'NO_ACTIVE_PAUSE') {
      return res.status(404).json({ error: err.message });
    }
    logger.error({ msg: 'Resume failed', owner, repo, issue_number, error: err.message });
    res.status(500).json({ error: 'Resume failed', detail: err.message });
  }
});

// GET /api/pause/:owner/:repo/:issue — get active pause
router.get('/pause/:owner/:repo/:issue', async (req, res) => {
  const { owner, repo, issue } = req.params;
  const issueNumber = parseInt(issue, 10);
  if (isNaN(issueNumber) || issueNumber < 1) {
    return res.status(400).json({ error: 'Invalid issue number' });
  }

  try {
    const pause = await getActivePause(`${owner}/${repo}`, issueNumber);
    if (!pause) {
      return res.status(404).json({ error: 'No active pause found' });
    }
    res.json({ pause });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get pause', detail: err.message });
  }
});

export default router;
