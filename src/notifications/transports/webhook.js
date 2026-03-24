/**
 * Webhook transport — sends wake payload via HTTP POST.
 */
import logger from '../../logger.js';

/**
 * @param {object} agentConfig - { url, token_env, ... }
 * @param {object} payload - standardized wake payload
 */
export async function send(agentConfig, payload) {
  const url = agentConfig.url;
  if (!url) {
    logger.warn({ msg: 'Webhook transport: no URL configured', agentId: payload.agentId });
    return;
  }

  const headers = { 'Content-Type': 'application/json' };
  const token = agentConfig.token_env ? process.env[agentConfig.token_env] : null;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.error({ msg: 'Webhook transport failed', status: response.status, agentId: payload.agentId, body });
    } else {
      logger.info({ msg: 'Agent notified via webhook', agentId: payload.agentId, url });
    }
  } catch (err) {
    logger.error({ msg: 'Webhook transport error', agentId: payload.agentId, error: err.message });
  }
}
