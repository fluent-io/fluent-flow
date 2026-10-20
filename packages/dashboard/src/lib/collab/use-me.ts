'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LatestRequest } from './live';
import { collabFetch } from './api';
import type { MeResponse } from './types';

export function useMe() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const requests=useRef(new LatestRequest());
  const reload = useCallback(async () => {
    const signal=requests.current.begin();
    try {
      const result = await collabFetch<MeResponse>('/me',{signal});
      if(!requests.current.current(signal)) return;
      setMe(result.data);
      setError(null);
    } catch (err) {
      if(!requests.current.current(signal))return;
      setMe(null);
      setError(err instanceof Error ? err.message : 'Failed to load your workspaces.');
    } finally {
      if(requests.current.current(signal))setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return ()=>requests.current.dispose();
  }, [reload]);

  return { me, error, loading, reload };
}

/** Effective capabilities for a project, from the server's /me projection. */
export function capabilitiesFor(me: MeResponse | null, projectId: string): string[] {
  return me?.capabilities[projectId] ?? [];
}

/** Workspace-scope capabilities only; never inferred from project roles. */
export function workspaceCapabilitiesFor(me: MeResponse | null, workspaceId: string): string[] {
  return me?.workspaceCapabilities?.[workspaceId] ?? [];
}
