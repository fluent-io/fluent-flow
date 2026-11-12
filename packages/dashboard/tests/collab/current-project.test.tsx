import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from 'next-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@/lib/collab/types';

let currentSession: Session | null = null;
let pathname = '/board';
vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSession: () => (currentSession ? { data: currentSession, status: 'authenticated' } : { data: null, status: 'loading' }),
  signOut: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}));

const {
  boardScope,
  createTaskTarget,
  catalogForSession,
  currentProjectStorageKey,
  resolveCurrentProject,
  routeForProjectSelection,
} = await import('@/lib/collab/current-project');
const { DashboardShell } = await import('@/components/layout/dashboard-shell');
const { ProjectOverviewPanel, ProjectsList } = await import('@/components/collab/projects-view');

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const B1 = '33333333-3333-4333-8333-333333333333';
const project = (id: string, workspaceId: string, name: string) => ({ id, workspaceId, name, version: 1, boardVersion: 1, executionDefaults: null, linkedRepoFullName: null });

const ownerMe: MeResponse = {
  principal: { id: 'p-owner', displayName: 'Owner', disabledAt: null, sessionVersion: 1 } as MeResponse['principal'],
  workspaces: [
    { id: 'w-a', name: 'Client A', orgId: null, projects: [project(A1, 'w-a', 'A1'), project(A2, 'w-a', 'A2')] },
    { id: 'w-b', name: 'Client B', orgId: null, projects: [project(B1, 'w-b', 'B1')] },
  ],
  capabilities: { [A1]: ['task.read', 'task.write', 'project.admin'], [A2]: ['task.read'], [B1]: ['task.read', 'task.write'] },
  workspaceCapabilities: { 'w-a': ['project.admin'], 'w-b': [] },
} as MeResponse;

const collaboratorMe: MeResponse = {
  ...ownerMe,
  principal: { id: 'p-collab', displayName: 'Collaborator', disabledAt: null, sessionVersion: 1 } as MeResponse['principal'],
  workspaces: [{ id: 'w-a', name: 'Client A', orgId: null, projects: [project(A1, 'w-a', 'A1')] }],
  capabilities: { [A1]: ['task.read', 'task.write'] },
  workspaceCapabilities: {},
};

function session(user: Partial<Session['user']>): Session {
  return { expires: '2099-01-01T00:00:00.000Z', user: { id: null, principalId: 'p-collab', sessionVersion: 1, login: 'Collaborator', email: null, image: null, isSuperadmin: false, orgs: [], ...user } } as Session;
}

beforeEach(() => {
  currentSession = null;
  pathname = '/board';
  vi.stubGlobal('React', React);
});
afterEach(() => vi.unstubAllGlobals());

describe('saved current-project selection', () => {
  it('is stored per signed-in principal and session version', () => {
    expect(currentProjectStorageKey('p-owner', 1)).not.toBe(currentProjectStorageKey('p-collab', 1));
    expect(currentProjectStorageKey('p-owner', 1)).toContain('p-owner');
    expect(currentProjectStorageKey('p-owner', 1)).toBe(currentProjectStorageKey('p-owner', 1));
    expect(currentProjectStorageKey('p-owner', 2)).not.toBe(currentProjectStorageKey('p-owner', 1));
  });

  it('only trusts a catalog loaded for the same principal and session version', () => {
    expect(catalogForSession(ownerMe, { principalId: 'p-owner', sessionVersion: 1 })).toBe(ownerMe);
    expect(catalogForSession(ownerMe, { principalId: 'p-owner', sessionVersion: 2 })).toBeNull();
    expect(catalogForSession(ownerMe, { principalId: 'p-collab', sessionVersion: 1 })).toBeNull();
    expect(catalogForSession(null, { principalId: 'p-owner', sessionVersion: 1 })).toBeNull();
  });

  it('stays pending while the catalog loads, without treating loading as revocation', () => {
    expect(resolveCurrentProject(null, A1)).toEqual({ status: 'pending', project: null, invalid: false });
  });

  it('exposes only projects in the current membership catalog', () => {
    const resolved = resolveCurrentProject(ownerMe, A2);
    expect(resolved.status).toBe('ready');
    expect(resolved.project).toMatchObject({ id: A2, name: 'A2', workspaceId: 'w-a', workspaceName: 'Client A' });
    expect(resolved.invalid).toBe(false);
  });

  it('marks a revoked or another account\'s saved project invalid and exposes nothing', () => {
    expect(resolveCurrentProject(collaboratorMe, A2)).toEqual({ status: 'ready', project: null, invalid: true });
    expect(resolveCurrentProject(collaboratorMe, 'not-a-project')).toEqual({ status: 'ready', project: null, invalid: true });
  });

  it('treats no saved value as All projects', () => {
    expect(resolveCurrentProject(ownerMe, null)).toEqual({ status: 'ready', project: null, invalid: false });
  });
});

describe('header selection routing', () => {
  it('moves the board to the selected project and keeps the search', () => {
    expect(routeForProjectSelection('/board', A1, '?q=fix&workspaceId=w-b')).toBe(`/board?q=fix&projectId=${A1}`);
    expect(routeForProjectSelection('/board', null, `?q=fix&projectId=${A1}`)).toBe('/board?q=fix');
  });

  it('leaves a task for the selected project board instead of relabeling it', () => {
    expect(routeForProjectSelection('/tasks/abc', A2, '')).toBe(`/board?projectId=${A2}`);
    expect(routeForProjectSelection('/tasks/abc', null, '')).toBe('/board');
  });

  it('follows the selection on project detail and settings', () => {
    expect(routeForProjectSelection(`/projects/${A1}`, A2, '')).toBe(`/projects/${A2}`);
    expect(routeForProjectSelection(`/projects/${A1}`, null, '')).toBe('/projects');
    expect(routeForProjectSelection('/settings', A2, '')).toBe(`/settings?projectId=${A2}`);
  });

  it('keeps list, attention and legacy org-scoped pages in place', () => {
    for (const path of ['/projects', '/attention', '/agents', '/repos', '/pipelines']) {
      expect(routeForProjectSelection(path, A1, '')).toBeNull();
    }
  });
});

describe('board scope', () => {
  it('gives an explicit project deep link precedence over the remembered selection', () => {
    expect(boardScope({ projectId: A1, workspaceId: '' }, { ready: true, projectId: A2 })).toEqual({ ready: true, projectId: A1 });
  });

  it('uses the remembered selection when the link has no project', () => {
    expect(boardScope({ projectId: '', workspaceId: '' }, { ready: true, projectId: A2 })).toEqual({ ready: true, projectId: A2 });
  });

  it('waits for the selection instead of briefly loading every project', () => {
    expect(boardScope({ projectId: '', workspaceId: '' }, { ready: false, projectId: null })).toEqual({ ready: false, projectId: '' });
  });

  it('keeps an explicit client filter when the remembered project is elsewhere', () => {
    expect(boardScope({ projectId: '', workspaceId: 'w-b' }, { ready: true, projectId: A2 })).toEqual({ ready: true, projectId: '' });
  });
});

describe('task creation target', () => {
  const all = ownerMe.workspaces.flatMap((w) => w.projects);

  it('defaults to the selected project', () => {
    expect(createTaskTarget(all, ownerMe, B1)).toEqual({ projectIds: [B1], defaultProjectId: B1, refusal: null });
  });

  it('refuses a selected project the user cannot write to', () => {
    const target = createTaskTarget(all, ownerMe, A2);
    expect(target.projectIds).toEqual([]);
    expect(target.defaultProjectId).toBeNull();
    expect(target.refusal).toMatch(/A2/);
  });

  it('offers every writable project for All projects', () => {
    expect(createTaskTarget(all, ownerMe, null)).toEqual({ projectIds: [A1, B1], defaultProjectId: A1, refusal: null });
  });
});

describe('shell navigation and header', () => {
  it('shows Projects and the Current project selector to collaborators', () => {
    currentSession = session({});
    const html = renderToStaticMarkup(<DashboardShell><div>Content</div></DashboardShell>);
    expect(html).toContain('<span>Projects</span>');
    expect(html).toContain('href="/projects"');
    for (const label of ['Board', 'Projects', 'Needs attention']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('aria-label="Current project"');
    expect(html).toContain('Loading projects…');
    expect(html).not.toContain('All projects');
  });

  it('shows Projects alongside legacy navigation for internal users', () => {
    currentSession = session({ id: 7, principalId: 'p-owner', login: 'owner', orgs: [{ user_id: 7, org_id: 'acme', role: 'admin' }] } as Partial<Session['user']>);
    const html = renderToStaticMarkup(<DashboardShell><div>Content</div></DashboardShell>);
    for (const label of ['Board', 'Projects', 'Needs attention', 'Agents', 'Settings']) expect(html).toContain(`<span>${label}</span>`);
  });
});

describe('project pages', () => {
  const overview = { id: A1, workspaceId: 'w-a', workspaceName: 'Client A', name: 'A1', version: 3, boardVersion: 2, linkedRepoFullName: null, description: 'Arithmetic demo', runInstructions: '', testInstructions: 'npm test' };

  it('lets a collaborator read the overview without edit controls', () => {
    const html = renderToStaticMarkup(<ProjectOverviewPanel overview={overview} canEdit={false} canOpenSettings={false} onSaved={() => {}} />);
    expect(html).toContain('Arithmetic demo');
    expect(html).toContain('npm test');
    expect(html).toContain('No run instructions yet.');
    expect(html).not.toContain('Edit overview');
    expect(html).not.toContain('href="/settings');
    expect(html).toContain(`href="/board?projectId=${A1}"`);
  });

  it('shows linked repositories on project lists and details', () => {
    const linked = { ...overview, linkedRepoFullName: 'acme/app' };
    expect(renderToStaticMarkup(<ProjectOverviewPanel overview={linked} canEdit={false} canOpenSettings={false} onSaved={() => {}} />)).toContain('acme/app');
    const me = { ...ownerMe, workspaces: [{ ...ownerMe.workspaces[0], projects: [{ ...ownerMe.workspaces[0].projects[0], linkedRepoFullName: 'acme/app' }] }] };
    expect(renderToStaticMarkup(<ProjectsList me={me} onCreated={async () => {}} />)).toContain('acme/app');
  });

  it('gives a project admin edit and settings controls', () => {
    const html = renderToStaticMarkup(<ProjectOverviewPanel overview={overview} canEdit canOpenSettings onSaved={() => {}} />);
    expect(html).toContain('Edit overview');
    expect(html).toContain(`href="/settings?projectId=${A1}"`);
  });

  it('lists only catalog projects grouped by client, with creation only where allowed', () => {
    const html = renderToStaticMarkup(<ProjectsList me={ownerMe} onCreated={async () => {}} />);
    expect(html).toContain('Client A');
    expect(html).toContain('Client B');
    for (const id of [A1, A2, B1]) expect(html).toContain(`href="/projects/${id}"`);
    expect(html.match(/Create project/g)?.length).toBe(1);

    const collaboratorHtml = renderToStaticMarkup(<ProjectsList me={collaboratorMe} onCreated={async () => {}} />);
    expect(collaboratorHtml).toContain(`href="/projects/${A1}"`);
    expect(collaboratorHtml).not.toContain(A2);
    expect(collaboratorHtml).not.toContain('Client B');
    expect(collaboratorHtml).not.toContain('Create project');
  });

  it('shows an empty state when the user has no projects', () => {
    const html = renderToStaticMarkup(<ProjectsList me={{ ...collaboratorMe, workspaces: [] }} onCreated={async () => {}} />);
    expect(html).toContain('No projects yet');
  });
});
