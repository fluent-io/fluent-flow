/**
 * Typed collaboration service errors. `status`/`code` map to the public error
 * contract in docs/plans/2026-10-19-collaborative-contracts.md; `message` is
 * written to be user-safe (never contains SQL, paths, tokens or internals).
 */
export class CollabServiceError extends Error {
  readonly status: number;
  readonly code: string;
  /** Non-secret conflict metadata (e.g. currentVersion) for authorized callers. */
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CollabServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Typed 429 for throttled login/invitation-redemption attempts. */
export class CollabRateLimitError extends CollabServiceError {
  constructor() {
    super(429, 'rate_limited', 'Too many attempts. Try again later.');
    this.name = 'CollabRateLimitError';
  }
}
