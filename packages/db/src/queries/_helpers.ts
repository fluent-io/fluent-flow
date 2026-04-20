/**
 * SQL fragment projecting agent_sessions.status with a read-time TTL guard.
 * Inline into SELECT lists that read from agent_sessions. Writers must not use it.
 *
 * Why: a runner that dies without calling /offline leaves status='online' in
 * the row; expires_at is the source of truth for liveness. Display queries
 * project the computed value so stale rows surface as offline without a write.
 */
export const SESSION_STATUS_AT_READ_TIME = `CASE
          WHEN status <> 'offline' AND expires_at > NOW() THEN status
          ELSE 'offline'
        END`;
