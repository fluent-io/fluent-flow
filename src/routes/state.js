import { Router } from 'express';
import { getCurrentState, getTransitionHistory } from '../engine/state-machine.js';

const router = Router();

// GET /api/state/:owner/:repo/:issue
router.get('/state/:owner/:repo/:issue', async (req, res) => {
  const { owner, repo, issue } = req.params;
  const issueNumber = parseInt(issue, 10);

  if (isNaN(issueNumber) || issueNumber < 1) {
    return res.status(400).json({ error: 'Invalid issue number' });
  }

  const repoKey = `${owner}/${repo}`;

  try {
    const [currentState, history] = await Promise.all([
      getCurrentState(repoKey, issueNumber),
      getTransitionHistory(repoKey, issueNumber),
    ]);

    res.json({
      owner,
      repo,
      issueNumber,
      currentState,
      history,
    });
  } catch (err) {
    console.error({ msg: 'Failed to get state', owner, repo, issueNumber, error: err.message });
    res.status(500).json({ error: 'Failed to get state', detail: err.message });
  }
});

export default router;
