import { expireSessions } from '../agents/session-manager.js';
import logger from '../logger.js';

const SLEEP_MS = 60_000;

export async function expireSessionsTick() {
  try {
    return await expireSessions();
  } catch (err) {
    logger.error({ msg: 'expireSessionsTick: error', error: err.message });
  }
}

export async function startSessionExpiryWorker() {
  logger.info({ msg: 'startSessionExpiryWorker: started', intervalMs: SLEEP_MS });
  while (true) {
    try {
      await expireSessionsTick();
      await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    } catch (err) {
      logger.error({ msg: 'startSessionExpiryWorker: unhandled error', error: err.message });
      await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    }
  }
}
