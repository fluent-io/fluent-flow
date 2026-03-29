import { createHmac, timingSafeEqual } from 'crypto';
import logger from '../logger.js';

/**
 * Middleware that captures the raw request body for signature verification.
 * Must be used before express.json().
 */
export function captureRawBody(req, res, buf) {
  req.rawBody = buf;
}

/**
 * Verify GitHub webhook signature (X-Hub-Signature-256).
 * @param {Buffer} rawBody - Raw request body
 * @param {string} signature - Value of X-Hub-Signature-256 header
 * @param {string} secret - Webhook secret
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;

  const expected = `sha256=${createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')}`;

  try {
    return timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expected, 'utf8')
    );
  } catch {
    return false;
  }
}

/**
 * Express middleware that verifies GitHub webhook signatures.
 * Returns 401 if signature is missing or invalid.
 */
export function webhookSignatureMiddleware(req, res, next) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn({ msg: 'GITHUB_WEBHOOK_SECRET not set — skipping signature verification' });
    return next();
  }

  const signature = req.headers['x-hub-signature-256'];
  const rawBody = req.rawBody;

  if (!rawBody) {
    return res.status(400).json({ error: 'Missing request body' });
  }

  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    logger.warn({ msg: 'Invalid webhook signature', ip: req.ip });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}
