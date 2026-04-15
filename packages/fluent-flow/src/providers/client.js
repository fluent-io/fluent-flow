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
 * All queued writes return the enqueued outbound queue row
 * ({ id, installation_id, kind, payload, client_ref, attempts, ... }),
 * not the provider API response. The worker performs the actual API call asynchronously.
 *
 * @property {function(repo: object, prNumber: number, body: string, ctx?: object): Promise<object>} postComment
 *   Enqueue a comment post. Returns the outbound queue row.
 *
 * @property {function(repo: object, prNumber: number, review: object, ctx?: object): Promise<object>} postReview
 *   Enqueue a PR review (approve / request changes / comment). Returns the outbound queue row.
 *
 * @property {function(repo: object, input: object, ctx?: object): Promise<object>} createCheckRun
 *   Enqueue a Check Run creation. Returns the outbound queue row.
 *   input: { name, head_sha, status, external_id? }
 *
 * @property {function(repo: object, checkRunId: number, input: object, ctx?: object): Promise<object>} updateCheckRun
 *   Enqueue a Check Run update. Returns the outbound queue row.
 *   input: { status, conclusion?, started_at?, completed_at?, output? }
 */
