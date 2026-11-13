'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, collabFetchAll } from '@/lib/collab/api';
import { LatestRequest, pollResource } from '@/lib/collab/live';
import { Button } from '@/components/ui/button';

type Receipt = { claimId: number; agentId: string | null; repo: string | null; retained: boolean | null; reason: string | null; reportedAt: string | null };
const reasons: Record<string,string> = {
  dirty: 'uncommitted files', unpushed: 'unpublished commits', scratch: 'session notes',
  inspection_failed: 'cleanup could not be verified', preparation_failed: 'workspace setup was interrupted',
};

export function RetainedWorkNotice({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<Receipt[]>([]);
  const [error, setError] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [denied, setDenied] = useState(false);
  const request = useRef(new LatestRequest());
  const load = useCallback(async (parent?: AbortSignal) => {
    const signal = request.current.begin(parent);
    try {
      const result = await collabFetchAll<Receipt>(`/tasks/${taskId}/retained-work?limit=50`, { signal });
      if (!request.current.current(signal)) return;
      setItems(result.data); setTruncated(result.truncated); setError(false);
    } catch (failure) {
      if (!request.current.current(signal)) return;
      if (failure instanceof ApiError && [401,403,404].includes(failure.status)) {
        setItems([]); setDenied(true);
      }
      setError(true);
    }
  }, [taskId]);
  useEffect(() => {
    if (denied) return;
    const stop = pollResource(load,5000);
    return () => { stop(); request.current.dispose(); };
  }, [load,denied]);
  if (denied) return null;
  if (error) return <p role="status" className="mt-3 text-xs text-muted-foreground">Workspace cleanup reports are unavailable. <Button variant="ghost" size="sm" onClick={() => void load()}>Retry</Button></p>;
  if (!items.length) return null;
  return <section aria-label="Retained work" className="mt-4 space-y-2 text-xs text-muted-foreground">
    <h3 className="font-medium text-foreground">Session workspaces</h3>
    {items.map(item => <p key={item.claimId}>Session {item.claimId}: {item.retained === null
      ? 'cleanup has not been reported; do not assume its files were removed.'
      : `last reported retained${item.agentId ? ` on agent ${item.agentId}` : ''} (${reasons[item.reason ?? ''] ?? 'inspection required'}).`}</p>)}
    <p>Ask the agent operator to push or explicitly discard retained work. Reports describe the last cleanup attempt; inspect that agent before acting.</p>
    {truncated && <p>Older workspace reports are not loaded.</p>}
  </section>;
}
