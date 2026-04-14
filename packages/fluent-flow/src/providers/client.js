/**
 * @fileoverview ProviderClient interface — JSDoc type documentation.
 * All provider implementations must conform to this interface.
 * No executable code is exported from this file.
 */

/**
 * @typedef {object} ProviderClient
 *
 * --- Read operations (synchronous / direct, not queued) ---
 *
 * @property {function(repo: object): Promise<Array>} listOpenPRs
 *   List all open pull requests for a repository.
 *
 * @property {function(repo: object, prNumber: number): Promise<object>} getPR
 *   Get details for a specific pull request.
 *
 * @property {function(repo: object, prNumber: number): Promise<string>} getDiff
 *   Get the unified diff for a pull request.
 *
 * @property {function(headers: object, rawBody: Buffer): boolean} verifyWebhook
 *   Verify that an inbound webhook payload has a valid HMAC signature.
 *
 * @property {function(headers: object, body: object): object} parseWebhookEvent
 *   Parse and validate an inbound webhook event payload.
 *
 * --- Write operations (queued through provider_outbound_queue) ---
 *
 * @property {function(repo: object, prNumber: number, body: string): Promise<void>} postComment
 *   Post a comment on an issue or pull request.
 *
 * @property {function(repo: object, prNumber: number, review: object): Promise<void>} postReview
 *   Submit a pull request review (approve / request changes / comment).
 *
 * @property {function(repo: object, input: object): Promise<object>} createCheckRun
 *   Create a GitHub Check Run for a commit.
 *   input: { name, head_sha, status, external_id? }
 *   Returns an object with { id } (the external check run id).
 *
 * @property {function(repo: object, checkRunId: number, input: object): Promise<void>} updateCheckRun
 *   Update an existing Check Run.
 *   input: { status, conclusion?, started_at?, completed_at?, output? }
 */
