import { Router } from 'express';
import { appWebhookSignatureMiddleware } from '../providers/github/webhook-verify.js';
import {
  handleInstallationCreated,
  handleInstallationSuspended,
  handleInstallationUnsuspended,
  handleInstallationDeleted,
  handleInstallationRepositoriesAdded,
  handleInstallationRepositoriesRemoved,
} from '../engine/installation-lifecycle.js';
import { routeWebhookEvent } from './webhook.js';
import logger from '../logger.js';

const router = Router();

// POST /webhooks/github-app — GitHub App webhook endpoint
router.post('/webhooks/github-app', appWebhookSignatureMiddleware, async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;

  // Respond immediately to GitHub
  res.status(200).json({ ok: true, event });

  try {
    await routeAppWebhookEvent(event, payload);
  } catch (err) {
    logger.error({ msg: 'App webhook processing error', event, error: err.message, stack: err.stack });
  }
});

/**
 * Route a GitHub App webhook event to the appropriate handler.
 */
async function routeAppWebhookEvent(event, payload) {
  logger.info({ msg: 'App webhook received', event, action: payload.action });

  switch (event) {
    case 'installation':
      await handleInstallationEvent(payload);
      break;
    case 'installation_repositories':
      await handleInstallationRepositoriesEvent(payload);
      break;
    default:
      // Forward all other events (pull_request, check_run, push, issues,
      // issue_comment, pull_request_review, projects_v2_item) to the shared
      // router. The PAT cutover in f668af9 (2026-04-14) dead-coded the prior
      // caller of routeWebhookEvent and never re-wired it here — every non-
      // install webhook has been silently dropping since.
      await routeWebhookEvent(event, payload);
  }
}

async function handleInstallationEvent(payload) {
  const { action, installation } = payload;
  switch (action) {
    case 'created':
      await handleInstallationCreated(payload);
      break;
    case 'suspend':
      await handleInstallationSuspended(installation.id);
      break;
    case 'unsuspend':
      await handleInstallationUnsuspended(installation.id);
      break;
    case 'deleted':
      await handleInstallationDeleted(installation.id);
      break;
    default:
      logger.info({ msg: 'Unhandled installation action', action });
  }
}

async function handleInstallationRepositoriesEvent(payload) {
  const { action } = payload;
  switch (action) {
    case 'added':
      await handleInstallationRepositoriesAdded(payload);
      break;
    case 'removed':
      await handleInstallationRepositoriesRemoved(payload);
      break;
    default:
      logger.info({ msg: 'Unhandled installation_repositories action', action });
  }
}

export default router;
