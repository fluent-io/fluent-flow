const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface TaskSelection {
  taskId: string | null;
  claimId: number | null;
  runId: string | null;
  sessionId: string | null;
}
export interface HistoricalSelection {
  runId: string;
  sessionId: string | null;
}
export function taskSelection(params: Pick<URLSearchParams, 'get'>): TaskSelection {
  const task = params.get('taskId');
  const claim = params.get('claimId');
  const run = params.get('runId');
  const session = params.get('sessionId');
  const taskId = task && UUID.test(task) ? task.toLowerCase() : null;
  const claimId = taskId && claim && /^[1-9]\d*$/.test(claim) && Number.isSafeInteger(Number(claim)) ? Number(claim) : null;
  const runId = taskId && claimId === null && run && UUID.test(run) ? run.toLowerCase() : null;
  const sessionId = runId && session && UUID.test(session) ? session.toLowerCase() : null;
  return { taskId, claimId, runId, sessionId };
}
export function taskHref(query: string, taskId: string | null, claimId: number | null = null, history: HistoricalSelection | null = null): string {
  const original = new URLSearchParams(query);
  const next = new URLSearchParams();
  for (const [key, value] of original) if (['workspaceId', 'projectId', 'q'].includes(key)) next.set(key, value);
  if (taskId && UUID.test(taskId)) {
    next.set('taskId', taskId.toLowerCase());
    if (claimId !== null && Number.isSafeInteger(claimId) && claimId > 0) next.set('claimId', String(claimId));
    else if (history && UUID.test(history.runId)) {
      next.set('runId', history.runId.toLowerCase());
      if (history.sessionId && UUID.test(history.sessionId)) next.set('sessionId', history.sessionId.toLowerCase());
    }
  }
  return `/board${next.size ? `?${next}` : ''}`;
}
