'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, collabFetch } from '@/lib/collab/api';
import { LatestRequest } from '@/lib/collab/live';
import type { HistoricalSelection } from '@/lib/collab/task-navigation';

export interface ExecutionSourceNavigation {
  onSelectClaim: (claimId: number) => void;
  onSelectHistory: (selection: HistoricalSelection | null) => void;
}

export interface ExecutionSourceReference {
  claimId?: number | null;
  runId?: string | null;
  sessionId?: string | null;
  commandId?: string | null;
}

export function ExecutionSourceLink({ taskId, source, internalRead, navigation, label = 'View execution source' }: {
  taskId: string;
  source: ExecutionSourceReference;
  internalRead: boolean;
  navigation: ExecutionSourceNavigation;
  label?: string;
}) {
  const { claimId, runId, sessionId, commandId } = source;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const requests = useRef(new LatestRequest());
  const scope = [taskId, claimId, runId, sessionId, commandId, internalRead].join(':');
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    setBusy(false);
    setError(null);
    setDenied(false);
    return () => requests.current.dispose();
  }, [scope]);

  async function openSource() {
    if (!internalRead || denied) return;
    if (typeof claimId === 'number') {
      navigation.onSelectClaim(claimId);
      return;
    }
    if (!commandId && runId) {
      navigation.onSelectHistory({ runId, sessionId: sessionId ?? null });
      return;
    }
    const reference: Record<string, string> | null = commandId ? { commandId } : sessionId ? { sessionId } : null;
    if (!reference) return;
    const signal = requests.current.begin();
    setBusy(true);
    setError(null);
    try {
      const result = await collabFetch<HistoricalSelection>(`/tasks/${taskId}/execution-history/reference?${new URLSearchParams(reference)}`, { signal });
      if (!requests.current.current(signal) || currentScope.current !== scope) return;
      navigation.onSelectHistory({ runId: result.data.runId, sessionId: result.data.sessionId });
    } catch (failure) {
      if (!requests.current.current(signal) || currentScope.current !== scope) return;
      if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
        setDenied(true);
        setError('Execution history is no longer available.');
      } else {
        setError('Could not open execution history. Try again.');
      }
    } finally {
      if (requests.current.current(signal) && currentScope.current === scope) setBusy(false);
    }
  }

  if (!internalRead || (typeof claimId !== 'number' && !runId && !sessionId && !commandId)) return null;
  return <div className="mt-2 text-xs">
    {!denied ? <button type="button" disabled={busy} className="text-left underline underline-offset-4 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void openSource()}>
      {busy ? 'Opening history…' : label}
    </button> : null}
    {error ? <p role="status" className="mt-1 text-muted-foreground">{error}</p> : null}
  </div>;
}
