const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function taskSelection(params: Pick<URLSearchParams, 'get'>): { taskId: string | null; claimId: number | null } {
  const task = params.get('taskId');
  const claim = params.get('claimId');
  const taskId = task && UUID.test(task) ? task : null;
  const claimId = claim && /^[1-9]\d*$/.test(claim) && Number.isSafeInteger(Number(claim)) ? Number(claim) : null;
  return { taskId, claimId: taskId ? claimId : null };
}
export function taskHref(query: string, taskId: string | null, claimId: number | null = null): string {
  const original = new URLSearchParams(query);
  const next = new URLSearchParams();
  for (const [key, value] of original) if (['workspaceId', 'projectId', 'q'].includes(key)) next.set(key, value);
  if (taskId && UUID.test(taskId)) {
    next.set('taskId', taskId);
    if (claimId !== null && Number.isSafeInteger(claimId) && claimId > 0) next.set('claimId', String(claimId));
  }
  return `/board${next.size ? `?${next}` : ''}`;
}
