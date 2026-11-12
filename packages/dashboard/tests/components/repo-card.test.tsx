import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RepoListItem } from '@fluent-flow/db';
import type { MeResponse } from '@/lib/collab/types';
import { RepoCard } from '@/components/repos/repo-card';

const state = vi.hoisted(() => ({
  me: null as MeResponse | null,
  loading: false,
  error: null as string | null,
  denied: false,
  reload: vi.fn(),
  push: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('@/lib/collab/use-me', async (original) => ({
  ...await original<typeof import('@/lib/collab/use-me')>(),
  useMe: () => ({ me: state.me, loading: state.loading, error: state.error, denied: state.denied, reload: state.reload }),
}));
vi.mock('@/components/repos/start-workflow-dialog', () => ({ StartWorkflowDialog: () => null }));
const repo: RepoListItem = { id: 'repo', org_id: 'org', repo_full_name: 'org/app', provider: 'github', created_at: new Date(), installation_id: '1', is_active: true, active_claims: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  state.me = null;
  state.loading = false;
  state.error = null;
  state.denied = false;
  state.me = {
    principal: { id: 'p', displayName: 'Admin', email: null, userId: 1, disabledAt: null, sessionVersion: 1 },
    workspaces: [
      { id: 'foreign', orgId: 'other', name: 'Other', projects: [] },
      { id: 'read-only', orgId: 'org', name: 'Read only', projects: [] },
      { id: 'target', orgId: 'org', name: 'Target', projects: [] },
    ],
    capabilities: {},
    workspaceCapabilities: { foreign: ['project.admin'], target: ['project.admin'] },
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: 'created' } }), { status: 201, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('RepoCard project creation', () => {
  it('uses an authorized workspace of the repo org and opens the created project', async () => {
    render(<RepoCard repo={repo} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/projects/created'));
    expect(fetch).toHaveBeenCalledWith('/api/collab/v1/workspaces/target/projects', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'app', repoFullName: 'org/app' }) }));
    expect(state.reload).toHaveBeenCalled();
  });

  it('explains when the org has no workspace', () => {
    state.me!.workspaces = state.me!.workspaces.filter((w) => w.orgId !== 'org');
    render(<RepoCard repo={repo} />);
    expect((screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('No workspace is available for this organization yet. Try signing in again.')).toBeTruthy();
  });

  it('requires workspace project.admin even when another org grants it', () => {
    state.me!.workspaceCapabilities = { foreign: ['project.admin'] };
    render(<RepoCard repo={repo} />);
    expect((screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('A workspace admin can create projects for this repository.')).toBeTruthy();
  });

  it('shows a safe retryable error without navigating on failure', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: { code: 'invalid_repo', message: 'private diagnostic' } }), { status: 422, headers: { 'content-type': 'application/json' } }));
    render(<RepoCard repo={repo} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This repository is no longer available for this workspace. Refresh and try again.');
    expect(state.push).not.toHaveBeenCalled();
  });

  it('shows a loading hint without retry while workspace access is still loading', () => {
    state.me = null;
    state.loading = true;
    render(<RepoCard repo={repo} />);
    expect((screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Loading workspace access…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(state.reload).not.toHaveBeenCalled();
  });

  it('shows a denied hint with retry when workspace access is denied', () => {
    state.me = null;
    state.denied = true;
    render(<RepoCard repo={repo} />);
    expect((screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Your workspace access could not be verified. Refresh to check your access.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(state.reload).toHaveBeenCalledTimes(1);
  });

  it('shows a failed-to-load hint with retry when workspace access fails to load', () => {
    state.me = null;
    state.error = 'Failed to load your workspaces.';
    render(<RepoCard repo={repo} />);
    expect((screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Could not load your workspaces.')).toBeTruthy();
    expect(screen.queryByText('Loading workspace access…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(state.reload).toHaveBeenCalledTimes(1);
  });
});
