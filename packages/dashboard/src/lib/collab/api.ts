/**
 * Browser-side client for the collaboration API through the same-origin proxy.
 * Client-safe by design: no database imports, no secrets — identity is carried
 * by the NextAuth session cookie and the proxy's signed actor assertion.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
    readonly currentVersion: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface CollabFetchInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface CollabResult<T> {
  data: T;
  nextCursor: string | null;
  /** Stable ingestion watermark for live collections even at the final page. */
  cursor?: string | null;
}

export async function collabFetch<T>(path: string, init: CollabFetchInit = {}): Promise<CollabResult<T>> {
  const headers = new Headers({ accept: 'application/json' });
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (init.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);

  const response = await fetch(`/api/collab/v1${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
    signal: init.signal,
  });

  let payload: unknown = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    payload = await response.json().catch(() => null);
  }

  if (!response.ok) {
    if (
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      payload.error &&
      typeof payload.error === 'object' &&
      'code' in payload.error
    ) {
      const err = payload.error as { code: string; message?: string; requestId?: string };
      const currentVersion =
        'currentVersion' in payload && typeof payload.currentVersion === 'number' ? payload.currentVersion : null;
      throw new ApiError(
        response.status,
        err.code,
        err.message ?? 'Request failed.',
        err.requestId ?? null,
        currentVersion,
      );
    }
    throw new ApiError(response.status, 'unexpected_response', 'Request failed. Try again.');
  }

  // 204 (revoke/remove) and any success without a body is a successful empty result.
  if (response.status === 204 || payload === null) {
    return { data: null as T, nextCursor: null };
  }

  if (typeof payload !== 'object' || !('data' in payload)) {
    throw new ApiError(response.status, 'unexpected_response', 'Request failed. Try again.');
  }

  const data = payload as { data: T; nextCursor?: string | null; cursor?: string | null };
  return { data: data.data, nextCursor: data.nextCursor ?? null, ...(typeof data.cursor === 'string' || data.cursor === null ? {cursor:data.cursor} : {}) };
}

/** Safety bound for full-list traversal; boards show a truncation notice past it. */
const MAX_TRAVERSED_PAGES = 20;

export interface CollabListResult<T> extends CollabResult<T[]> {
  /** True when the safety bound stopped traversal before the server's end. */
  truncated: boolean;
}

/**
 * Traverses a paginated collection to its end (or the safety bound), so boards
 * and counts never silently hide everything past the first page.
 */
export async function collabFetchAll<T>(path: string, init: CollabFetchInit = {}): Promise<CollabListResult<T>> {
  const [basePath, existingQuery] = path.split('?');
  const params = new URLSearchParams(existingQuery ?? '');
  if (!params.has('limit')) params.set('limit', '100');

  const items: T[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    if (cursor) params.set('cursor', cursor);
    else params.delete('cursor');
    const query = params.toString();
    const result = await collabFetch<T[]>(`${basePath}${query ? `?${query}` : ''}`, init);
    items.push(...result.data);
    cursor = result.nextCursor;
    pages += 1;
  } while (cursor && pages < MAX_TRAVERSED_PAGES);

  return { data: items, nextCursor: cursor, truncated: Boolean(cursor) };
}
