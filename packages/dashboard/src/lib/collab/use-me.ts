'use client';

import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { LatestRequest, pollResource } from './live';
import { ApiError, collabFetch } from './api';
import type { MeResponse } from './types';

export interface MeState {
  me: MeResponse | null;
  error: string | null;
  loading: boolean;
  denied: boolean;
  reload: (parent?: AbortSignal) => Promise<void>;
}

const SHARED_ME_POLL_MS = 5000;

const MeContext = createContext<MeState | null>(null);

function useOwnMe(enabled: boolean, pollMs?: number): MeState {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  const requests=useRef(new LatestRequest());
  const reload = useCallback(async (parent?: AbortSignal) => {
    const signal=requests.current.begin(parent);
    try {
      const result = await collabFetch<MeResponse>('/me',{signal});
      if(!requests.current.current(signal)) return;
      setMe(result.data);
      setError(null);
      setDenied(false);
    } catch (err) {
      if(!requests.current.current(signal))return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setMe(null);
        setDenied(true);
      }
      setError(err instanceof Error ? err.message : 'Failed to load your workspaces.');
    } finally {
      if(requests.current.current(signal))setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (pollMs) {
      const stop = pollResource(reload, pollMs);
      return () => { stop(); requests.current.dispose(); };
    }
    void reload();
    return ()=>requests.current.dispose();
  }, [reload, enabled, pollMs]);

  return { me, error, loading, denied, reload };
}

export function MeProvider({ children }: { children: React.ReactNode }) {
  const state = useOwnMe(true, SHARED_ME_POLL_MS);
  return createElement(MeContext.Provider, { value: state }, children);
}

export function useMe(): MeState {
  const shared = useContext(MeContext);
  const own = useOwnMe(shared === null);
  return shared ?? own;
}

export function capabilitiesFor(me: MeResponse | null, projectId: string): string[] {
  return me?.capabilities[projectId] ?? [];
}

export function workspaceCapabilitiesFor(me: MeResponse | null, workspaceId: string): string[] {
  return me?.workspaceCapabilities?.[workspaceId] ?? [];
}
