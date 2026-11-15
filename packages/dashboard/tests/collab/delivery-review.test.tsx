import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkpadTab } from '@/components/collab/task-workpad-tab';
import type { TaskDetail } from '@/components/collab/task-detail';

const at = '2026-11-14T00:00:00Z';
const detail: TaskDetail = { id: 'task-a', projectId: 'project-a', title: 'Native delivery', description: '', status: 'review', priority: 'normal',
  assigneeId: null, version: 3, position: '1000', blockedReason: null, createdAt: at, updatedAt: at, capabilities: ['task.read', 'delivery.accept'] };
const delivery = { id: 'delivery-a', taskId: detail.id, note: 'Ready for human review', artifactIds: [], checkEvidenceIds: [], openItemIds: [], createdAt: at, createdBy: 'owner' };
const review = { deliveryId: delivery.id, runId: null, source: { kind: 'claim', claimId: 21 }, headCommit: 'a'.repeat(40), dirty: false, evidenceRevision: 'current', openItems: [] };
const saved = { id: 'decision-a', taskId: detail.id, decision: 'accept', note: 'Earlier acceptance', acknowledgedOpenItemIds: [], deliveryId: delivery.id,
  taskVersion: 2, decidedByPrincipalId: 'owner', createdAt: at, reviewSnapshot: { ...review, source: { kind: 'claim', claimId: 17 }, headCommit: 'b'.repeat(40) } };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps the current native source distinct from the source captured in a previous human acceptance', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://localhost').pathname;
    let data: unknown = [];
    if (path.endsWith('/deliveries')) data = [delivery];
    else if (path.endsWith('/delivery-review')) data = review;
    else if (path.endsWith('/decisions')) data = [saved];
    else if (path.endsWith('/plan')) data = { plan: null };
    return new Response(JSON.stringify({ data, nextCursor: null }), { headers: { 'content-type': 'application/json' } });
  }));
  render(<WorkpadTab detail={detail} setDetail={() => {}} reload={async () => {}} sourceNavigation={{ onSelectClaim: vi.fn(), onSelectHistory: vi.fn() }} />);
  const current = await screen.findByRole('region', { name: 'Current delivery source' });
  expect(within(current).getByText(/claim #21/i)).toBeTruthy();
  expect(within(current).getByText(new RegExp('a'.repeat(40)))).toBeTruthy();
  const history = await screen.findByRole('region', { name: 'Decision history' });
  expect(await within(history).findByText(/claim #17/i)).toBeTruthy();
  expect(within(history).getByText(new RegExp('b'.repeat(40)))).toBeTruthy();
  expect(within(history).queryByText(/claim #21/i)).toBeNull();
  expect(within(current).queryByText(/claim #17/i)).toBeNull();
});
