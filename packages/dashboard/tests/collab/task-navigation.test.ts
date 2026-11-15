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
    expect(taskSelection(new URLSearchParams(taskHref('', id, 41).split('?')[1]))).toEqual({taskId:id,claimId:41});
  });
  it('rejects malformed and unsafe selection identifiers before requests', () => {
    for (const query of ['taskId=../secret&claimId=1', `taskId=${id}&claimId=9007199254740992`, `taskId=${id}&claimId=-2`]) {
      const result = taskSelection(new URLSearchParams(query));
      expect(result.claimId).toBeNull();
    }
    expect(taskSelection(new URLSearchParams('taskId=foreign'))).toEqual({ taskId:null, claimId:null });
  });
});
