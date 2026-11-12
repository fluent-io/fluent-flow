'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { capabilitiesFor, useMe } from './use-me';
import type { MeResponse, Project, Workspace } from './types';

export type CatalogProject = Project & { workspaceName: string };

export interface CurrentProjectResolution {
  status: 'pending' | 'ready';
  project: CatalogProject | null;
  invalid: boolean;
}

export function currentProjectStorageKey(principalId: string, sessionVersion: number): string {
  return `fluent-flow:current-project:${principalId}:${sessionVersion}`;
}

export function catalogForSession(
  me: MeResponse | null,
  session: { principalId: string | null; sessionVersion: number | null },
): MeResponse | null {
  if (!me || me.principal.id !== session.principalId || me.principal.sessionVersion !== session.sessionVersion) return null;
  return me;
}

export function catalogProjects(me: MeResponse | null): CatalogProject[] {
  return (me?.workspaces ?? []).flatMap((w) => w.projects.map((p) => ({ ...p, workspaceName: w.name })));
}

export function resolveCurrentProject(me: MeResponse | null, storedId: string | null): CurrentProjectResolution {
  if (!me) return { status: 'pending', project: null, invalid: false };
  if (!storedId) return { status: 'ready', project: null, invalid: false };
  const project = catalogProjects(me).find((p) => p.id === storedId) ?? null;
  return { status: 'ready', project, invalid: project === null };
}

export function routeForProjectSelection(pathname: string, projectId: string | null, search: string): string | null {
  if (pathname === '/board') {
    const params = new URLSearchParams(search);
    if (projectId) {
      params.set('projectId', projectId);
      params.delete('workspaceId');
    } else {
      params.delete('projectId');
    }
    const query = params.toString();
    return `/board${query ? `?${query}` : ''}`;
  }
  if (pathname.startsWith('/tasks/')) return projectId ? `/board?projectId=${projectId}` : '/board';
  if (pathname.startsWith('/projects/')) return projectId ? `/projects/${projectId}` : '/projects';
  if (pathname === '/settings') return projectId ? `/settings?projectId=${projectId}` : '/settings';
  return null;
}

export function boardScope(
  url: { projectId: string; workspaceId: string },
  selection: { ready: boolean; projectId: string | null },
): { ready: boolean; projectId: string } {
  if (url.projectId) return { ready: true, projectId: url.projectId };
  if (!selection.ready) return { ready: false, projectId: '' };
  if (url.workspaceId) return { ready: true, projectId: '' };
  return { ready: true, projectId: selection.projectId ?? '' };
}

export function createTaskTarget(
  projects: Project[],
  me: MeResponse | null,
  selectedProjectId: string | null,
): { projectIds: string[]; defaultProjectId: string | null; refusal: string | null } {
  const writable = projects.filter((p) => capabilitiesFor(me, p.id).includes('task.write')).map((p) => p.id);
  if (selectedProjectId) {
    if (writable.includes(selectedProjectId)) return { projectIds: [selectedProjectId], defaultProjectId: selectedProjectId, refusal: null };
    const name = projects.find((p) => p.id === selectedProjectId)?.name ?? 'this project';
    return { projectIds: [], defaultProjectId: null, refusal: `Read-only: you can't add tasks to ${name}.` };
  }
  return { projectIds: writable, defaultProjectId: writable[0] ?? null, refusal: null };
}

export interface CurrentProject {
  ready: boolean;
  projectId: string | null;
  project: CatalogProject | null;
  workspace: Workspace | null;
  workspaces: MeResponse['workspaces'];
  projects: CatalogProject[];
  catalogError: string | null;
  accessLost: boolean;
  retryCatalog: () => void;
  selectProject: (projectId: string | null) => void;
}

const fallback: CurrentProject = { ready: true, projectId: null, project: null, workspace: null, workspaces: [], projects: [], catalogError: null, accessLost: false, retryCatalog: () => {}, selectProject: () => {} };
const CurrentProjectContext = createContext<CurrentProject | null>(null);

function readSaved(key: string | null): string | null {
  return key && typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
}

export function CurrentProjectProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const principalId = session?.user.principalId ?? null;
  const sessionVersion = session?.user.sessionVersion ?? null;
  const { me: loadedMe, error: catalogError, denied: accessLost, reload } = useMe();
  const me = catalogForSession(loadedMe, { principalId, sessionVersion });
  const key = principalId && sessionVersion !== null ? currentProjectStorageKey(principalId, sessionVersion) : null;
  const [saved, setSaved] = useState<{ key: string | null; value: string | null }>(() => ({ key, value: readSaved(key) }));
  const savedValue = saved.key === key ? saved.value : readSaved(key);

  useEffect(() => {
    if (saved.key !== key) setSaved({ key, value: readSaved(key) });
  }, [key, saved.key]);

  const resolved = resolveCurrentProject(me, savedValue);

  useEffect(() => {
    if (!resolved.invalid || !key) return;
    window.localStorage.removeItem(key);
    setSaved({ key, value: null });
  }, [resolved.invalid, key]);

  const selectProject = useCallback(
    (projectId: string | null) => {
      if (!key) return;
      if (projectId && !catalogProjects(me).some((p) => p.id === projectId)) return;
      if (projectId) window.localStorage.setItem(key, projectId);
      else window.localStorage.removeItem(key);
      setSaved({ key, value: projectId });
    },
    [key, me],
  );

  const project = resolved.project;
  const value = useMemo<CurrentProject>(
    () => ({
      ready: resolved.status === 'ready',
      projectId: project?.id ?? null,
      project,
      workspace: project ? me?.workspaces.find((w) => w.id === project.workspaceId) ?? null : null,
      workspaces: me?.workspaces ?? [],
      projects: catalogProjects(me),
      catalogError: me ? null : catalogError,
      accessLost,
      retryCatalog: () => { void reload(); },
      selectProject,
    }),
    [resolved.status, project, me, catalogError, accessLost, reload, selectProject],
  );

  return <CurrentProjectContext.Provider value={value}>{children}</CurrentProjectContext.Provider>;
}

export function useCurrentProject(): CurrentProject {
  return useContext(CurrentProjectContext) ?? fallback;
}

export function useSyncCurrentProject(projectId: string | null) {
  const { ready, selectProject } = useCurrentProject();
  const synced = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId) {
      synced.current = null;
      return;
    }
    if (!ready || synced.current === projectId) return;
    synced.current = projectId;
    selectProject(projectId);
  }, [projectId, ready, selectProject]);
}
