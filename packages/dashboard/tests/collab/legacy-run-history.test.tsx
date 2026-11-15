import React, { useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { LegacyExecutionReader, LegacyRunHistory } from '@/components/collab/legacy-run-history';

const taskId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const entry = { runId, state: 'cancelled', stage: 'design', createdAt: '2026-11-13T01:00:00.123456Z', source: { kind: 'legacy', runId } };
const root = `/tasks/${taskId}/execution-history/${runId}`;
const timeline = (text: string, id = 'first') => ({ eventId: id, kind: 'timeline', payload: { item: { type: 'assistant_message', text } }, observedAt: '2026-11-13T01:00:00.000Z', providerCursor: null });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function HistoryHarness() {
  const [selected, setSelected] = useState<{ runId: string; sessionId: string | null } | null>(null);
  return selected
    ? <LegacyExecutionReader taskId={taskId} runId={selected.runId} sessionId={selected.sessionId} internalRead onBack={() => setSelected(null)} onSelectSession={id => setSelected({ ...selected, sessionId: id })} />
    : <LegacyRunHistory taskId={taskId} internalRead onSelectRun={id => setSelected({ runId: id, sessionId: null })} />;
}

it('opens original execution/session history and pages its transcript without execution controls', async () => {
  const requests: { method: string; path: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const path = String(input);
    requests.push({ method: init?.method ?? 'GET', path });
    if (path.includes('/timeline')) return Response.json(path.includes('cursor=')
      ? { data: [timeline('Agreed scope', 'second')], nextCursor: null }
      : { data: [timeline('Design first')], nextCursor: 'next-page' });
    if (path.includes(`${root}/sessions`)) return Response.json({ data: [{ id: sessionId, runId, title: 'Work session', state: 'cancelled', role: 'work', profileId: null, model: null, createdAt: null }] });
    if (path.endsWith(root)) return Response.json({ data: entry });
    return Response.json({ data: [entry], nextCursor: null });
  }));
  render(<HistoryHarness />);
  await userEvent.click(await screen.findByRole('button', { name: /View historical execution/ }));
  await userEvent.click(await screen.findByRole('button', { name: /Work session/ }));
  await screen.findByText('Design first');
  await userEvent.click(screen.getByRole('button', { name: 'Load more transcript' }));
  await screen.findByText('Agreed scope');
  expect(screen.getByText('Design first')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: /Send|Resume|Retry execution|End session/ })).toBeNull();
  expect(requests.every(request => request.method === 'GET' && !request.path.includes('/commands'))).toBe(true);
});

it('clears a private transcript when a subsequent page is denied', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
    const path = String(input);
    if (path.includes('/timeline')) return path.includes('cursor=')
      ? Response.json({ error: { code: 'forbidden', message: 'Denied', requestId: 'history-test' } }, { status: 403 })
      : Response.json({ data: [timeline('Previously private reply')], nextCursor: 'next-page' });
    return Response.json({ data: entry });
  }));
  render(<LegacyExecutionReader taskId={taskId} runId={runId} sessionId={sessionId} internalRead onBack={() => {}} onSelectSession={() => {}} />);
  await screen.findByText('Previously private reply');
  await userEvent.click(screen.getByRole('button', { name: 'Load more transcript' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('Previously private reply')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Load more transcript' })).toBeNull();
});

it('never paints a delayed transcript from the previously selected task', async () => {
  const nextTask = '44444444-4444-4444-8444-444444444444';
  const nextRun = '55555555-5555-4555-8555-555555555555';
  const nextSession = '66666666-6666-4666-8666-666666666666';
  let release!: (response: Response) => void;
  const delayed = new Promise<Response>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
    const path = String(input);
    if (path.includes('/timeline')) return path.includes(nextTask)
      ? Response.json({ data: [timeline('Current task transcript')] }) : delayed;
    return Response.json({ data: path.includes(nextTask) ? { ...entry, runId: nextRun, source: { kind: 'legacy', runId: nextRun } } : entry });
  }));
  const props = { internalRead: true, onBack: () => {}, onSelectSession: () => {} };
  const view = render(<LegacyExecutionReader {...props} taskId={taskId} runId={runId} sessionId={sessionId} />);
  await screen.findByText('Loading transcript…');
  view.rerender(<LegacyExecutionReader {...props} taskId={nextTask} runId={nextRun} sessionId={nextSession} />);
  await screen.findByText('Current task transcript');
  await act(async () => { release(Response.json({ data: [timeline('Old task private canary')] })); });
  expect(screen.queryByText('Old task private canary')).toBeNull();
  expect(screen.getByText('Current task transcript')).toBeTruthy();
});

it('removes private history immediately when internal-read authority is lost', async () => {
  const fetch = vi.fn(async (input: RequestInfo) => Response.json({ data: String(input).includes('/timeline') ? [timeline('Protected history')] : entry }));
  vi.stubGlobal('fetch', fetch);
  const props = { taskId, runId, sessionId, onBack: () => {}, onSelectSession: () => {} };
  const view = render(<LegacyExecutionReader {...props} internalRead />);
  await screen.findByText('Protected history');
  const priorCalls = fetch.mock.calls.length;
  view.rerender(<LegacyExecutionReader {...props} internalRead={false} />);
  expect(screen.queryByText('Protected history')).toBeNull();
  expect(screen.getByText('Execution history is available to project operators.')).toBeTruthy();
  expect(fetch.mock.calls.length).toBe(priorCalls);
});
