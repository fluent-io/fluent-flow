import { Router } from 'express';
import { z } from 'zod';
import { executeTransition, attemptTransitionToDone } from '../engine/state-machine.js';
import logger from '../logger.js';

const router = Router();

const TransitionSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  issue_number: z.number().int().positive(),
  to_state: z.string().min(1),
  trigger_type: z.string().default('api'),
  trigger_detail: z.string().optional(),
  actor: z.string().optional(),
  context: z
    .object({
      assignee: z.string().optional().nullable(),
      linked_pr: z.number().int().positive().optional().nullable(),
      merged_pr: z.number().int().positive().optional().nullable(),
      open_pr: z.number().int().positive().optional().nullable(),
    })
    .optional()
    .default({}),
  metadata: z.record(z.unknown()).optional(),
});

// POST /api/transition
router.post('/transition', async (req, res) => {
  const parsed = TransitionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }

  const { owner, repo, issue_number, to_state, trigger_type, trigger_detail, actor, context, metadata } = parsed.data;

  try {
    let result;

    if (to_state === 'Done') {
      result = await attemptTransitionToDone({
        owner,
        repo,
        issueNumber: issue_number,
        actor,
        context,
        triggerType: trigger_type,
      });

      if (result.reverted) {
        return res.status(422).json({
          error: 'Transition to Done blocked: no merged PR',
          reverted: true,
        });
      }
    } else {
      result = await executeTransition({
        owner,
        repo,
        issueNumber: issue_number,
        toState: to_state,
        triggerType: trigger_type,
        triggerDetail: trigger_detail,
        actor,
        context,
        metadata,
      });
    }

    res.json({
      ok: true,
      fromState: result.fromState,
      toState: result.toState,
      transition: result.transition,
    });
  } catch (err) {
    if (err.code === 'INVALID_TRANSITION') {
      return res.status(422).json({
        error: err.message,
        code: 'INVALID_TRANSITION',
        fromState: err.fromState,
        toState: err.toState,
      });
    }
    if (err.code === 'REQUIREMENTS_NOT_MET') {
      return res.status(422).json({
        error: err.message,
        code: 'REQUIREMENTS_NOT_MET',
        missing: err.missing,
      });
    }
    logger.error({ msg: 'Transition failed', owner, repo, issue_number, to_state, error: err.message });
    res.status(500).json({ error: 'Transition failed', detail: err.message });
  }
});

export default router;
