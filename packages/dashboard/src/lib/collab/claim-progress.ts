import type { ClaimExecutionBadge } from './types';
import { collabFetch } from './api';

export type ClaimProgressCard = {
  claimId: number;
  claimType: ClaimExecutionBadge['claimType'];
  attempt: number;
  status: ClaimExecutionBadge['status'];
  endReason: ClaimExecutionBadge['endReason'];
  createdAt: string;
  completedAt: string | null;
  lastSeq: number | null;
  readSeq: number | null;
  unread: boolean;
  needsInput: boolean;
  profile: string | null;
  model: string | null;
  targetAgentId: string | null;
};

export async function fetchTaskClaimProgress(taskId: string, signal?: AbortSignal): Promise<ClaimProgressCard[]> {
  const result = await collabFetch<ClaimProgressCard[]>(`/tasks/${taskId}/claim-progress`, { signal });
  return result.data;
}

export async function markClaimRead(claimId: number, seq: number, signal?: AbortSignal): Promise<{ claimId: number; lastSeq: number }> {
  const result = await collabFetch<{ claimId: number; lastSeq: number }>(`/claim-executions/${claimId}/read-cursor`, {
    method: 'POST',
    body: { seq },
    signal,
  });
  return result.data;
}
