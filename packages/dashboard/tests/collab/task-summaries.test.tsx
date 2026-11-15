import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskSummaries } from '@/components/collab/task-summaries';

const detail = { id: 'task-a', projectId: 'project-a', version: 1, capabilities: ['task.read', 'internal.read', 'run.start', 'run.steer'] };
const source = { kind: 'claim' as const, claimId: 7 };
const internal = { id: 'summary-a', body: 'Private generated summary.', visibility: 'internal', claimId: 8, runId: null, sessionId: null,
  model: 'small', profileId: 'design', source: { kind: 'claim', claimId: 7 }, sourceCursor: '12', sourceEntryCount: 5,
  sourceTruncated: false, provenance: 'agent', authorId: 'owner', createdAt: '2026-11-14T00:00:00Z' };
const generation = { enabled: true, configured: true, online: true, available: true, canGenerate: true };
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('renders generated provenance and frozen source without treating it as verification evidence', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ summaries: [internal], generation })));
  render(<TaskSummaries detail={detail} source={source} />);
  expect(await screen.findByText('Private generated summary.')).toBeTruthy();
  expect(screen.getByText(/not verification evidence/i)).toBeTruthy();
  expect(screen.getByText(/small/)).toBeTruthy();
  expect(screen.getByText(/event 12/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /approve|verified/i })).toBeNull();
});

it('requests AI work only on explicit action and displays the canonical result after publication', async () => {
  let published = false;
  let requested = false;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { requested = true; return response({ claimId: 8, taskId: detail.id, requestId: 'request-a', created: true }, 202); }
    return response({ summaries: published ? [internal] : [], generation });
  }));
  render(<TaskSummaries detail={detail} source={source} />);
  await screen.findByRole('button', { name: 'Generate summary' });
  expect(requested).toBe(false);
  expect(screen.queryByText('Private generated summary.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Generate summary' }));
  await screen.findByText(/summary requested/i);
  expect(screen.queryByText('Private generated summary.')).toBeNull();
  published = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh summaries' }));
  expect(await screen.findByText('Private generated summary.')).toBeTruthy();
});

it('masks private cached results immediately on current authority loss and ignores a late private response', async () => {
  let resolveOld: ((value: Response) => void) | undefined;
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    reads += 1;
    if (reads === 2) return new Promise<Response>(resolve => { resolveOld = resolve; });
    return response({ summaries: [internal], generation });
  }));
  const view = render(<TaskSummaries detail={detail} source={source} />);
  await screen.findByText('Private generated summary.');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh summaries' }));
  await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
  view.rerender(<TaskSummaries detail={{ ...detail, capabilities: ['task.read'] }} source={source} />);
  expect(screen.queryByText('Private generated summary.')).toBeNull();
  await act(async () => { resolveOld!(response({ summaries: [internal], generation })); });
  expect(screen.queryByText('Private generated summary.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Generate summary' })).toBeNull();
});

it('clears summaries and stops polling when summary access is revoked', async () => {
  let denied = false;
  const fetcher = vi.fn(async () => denied ? new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Unavailable.' } }), { status: 403 }) : response({ summaries: [internal], generation }));
  vi.stubGlobal('fetch', fetcher);
  render(<TaskSummaries detail={detail} source={source} />);
  await screen.findByText('Private generated summary.');
  denied = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh summaries' }));
  await screen.findByText('Summary access is no longer available.');
  expect(screen.queryByText('Private generated summary.')).toBeNull();
  const settledReads = fetcher.mock.calls.length;
  vi.useFakeTimers();
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(fetcher.mock.calls.length).toBe(settledReads);
});

it('shows only explicitly client-visible historical summaries to public readers', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ summaries: [internal, { ...internal, id: 'client-summary', body: 'Published client summary.', visibility: 'client', provenance: 'human' }], generation: null })));
  render(<TaskSummaries detail={{ ...detail, capabilities: ['task.read'] }} />);
  expect(await screen.findByText('Published client summary.')).toBeTruthy();
  expect(screen.queryByText('Private generated summary.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Generate summary' })).toBeNull();
});

it('does not silently replace missing configuration or generate without a selected source', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ summaries: [], generation: { ...generation, configured: false, canGenerate: false } })));
  const view = render(<TaskSummaries detail={detail} source={source} />);
  expect(await screen.findByText(/not configured/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Generate summary' })).toBeNull();
  view.rerender(<TaskSummaries detail={detail} />);
  expect(screen.queryByRole('button', { name: 'Generate summary' })).toBeNull();
});
