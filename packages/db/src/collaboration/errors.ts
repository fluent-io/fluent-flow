export class CollabServiceError extends Error {
  readonly status: number;
  readonly code: string;
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

export class CollabRateLimitError extends CollabServiceError {
  constructor() {
    super(429, 'rate_limited', 'Too many attempts. Try again later.');
    this.name = 'CollabRateLimitError';
  }
}
