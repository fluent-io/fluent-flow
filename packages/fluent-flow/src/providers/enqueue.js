import { enqueue } from '../db/outbound-queue.js';
import { createHash } from 'crypto';

/**
 * Build a deterministic client_ref for a provider action.
 * Format: <claim_id>:<kind>:<sha256-of-payload-prefix>
 *
 * @param {number|string} claimId
 * @param {string} kind
 * @param {object} payload
 * @returns {string}
 */
function buildClientRef(claimId, kind, payload) {
  const hash = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 12);
  return `${claimId}:${kind}:${hash}`;
}

/**
 * Enqueue a provider write action durably.
 *
 * @param {object} opts
 * @param {number} opts.installation_id
 * @param {string} opts.kind - e.g. 'comment', 'review', 'create_check_run', 'update_check_run'
 * @param {object} opts.payload - serialisable action payload
 * @param {number|string} opts.claim_id - used to build a deterministic client_ref
 * @returns {Promise<object>} The queue row
 */
export async function enqueueProviderAction({ installation_id, kind, payload, claim_id }) {
  const client_ref = buildClientRef(claim_id ?? 'anon', kind, payload);
  return enqueue({ installation_id, kind, payload, client_ref });
}
