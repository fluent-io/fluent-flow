import { describe, expect, it } from 'vitest';
import { taskSelection, taskHref } from '@/lib/collab/task-navigation';
const id = '22222222-2222-4222-8222-222222222222';
describe('board task selection', () => {
  it('keeps filters and removes the old session when selecting a task', () => {
    expect(taskHref('projectId=p&q=hello+world&workspaceId=w&claimId=31', id)).toBe(`/board?projectId=p&q=hello+world&workspaceId=w&taskId=${id}`);
  });
  it('closes a pasted link within the board, not arbitrary return URLs', () => {
    expect(taskHref(`q=search&taskId=${id}&claimId=4&returnTo=https://evil.test`, null)).toBe('/board?q=search');
  });
  it('round trips a valid selected session', () => {
    expect(taskSelection(new URLSearchParams(taskHref('', id, 41).split('?')[1]))).toMatchObject({taskId:id,claimId:41});
  });
  it('rejects malformed and unsafe selection identifiers before requests', () => {
    for (const query of ['taskId=../secret&claimId=1', `taskId=${id}&claimId=9007199254740992`, `taskId=${id}&claimId=-2`]) {
      const result = taskSelection(new URLSearchParams(query));
      expect(result.claimId).toBeNull();
    }
    expect(taskSelection(new URLSearchParams('taskId=foreign'))).toMatchObject({ taskId:null, claimId:null });
  });
  it('preserves original run and session UUIDs in board links without treating them as claims', () => {
    const runId = '33333333-3333-4333-8333-333333333333';
    const sessionId = '44444444-4444-4444-8444-444444444444';
    const href = taskHref('projectId=p&q=design&claimId=9', id, null, { runId, sessionId });
    expect(href).toContain('projectId=p&q=design');
    expect(taskSelection(new URLSearchParams(href.split('?')[1]))).toMatchObject({ taskId: id, claimId: null, runId, sessionId });
    expect(taskHref(href.split('?')[1], id, 8)).not.toMatch(/[?&](runId|sessionId)=/);
    expect(taskHref(href.split('?')[1], null)).toBe('/board?projectId=p&q=design');
  });
  it('selects at most one execution source and rejects orphaned historical sessions', () => {
    const runId = '33333333-3333-4333-8333-333333333333';
    const sessionId = '44444444-4444-4444-8444-444444444444';
    expect(taskSelection(new URLSearchParams(`taskId=${id}&claimId=8&runId=${runId}&sessionId=${sessionId}`))).toMatchObject({ claimId: 8, runId: null, sessionId: null });
    expect(taskSelection(new URLSearchParams(`taskId=${id}&sessionId=${sessionId}`))).toMatchObject({ runId: null, sessionId: null });
    expect(taskSelection(new URLSearchParams(`taskId=${id}&runId=7&sessionId=${sessionId}`))).toMatchObject({ runId: null, sessionId: null });
  });
});
