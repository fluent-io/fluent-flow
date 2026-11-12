'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ApiError, collabFetch } from '@/lib/collab/api';
import { useMe, workspaceCapabilitiesFor } from '@/lib/collab/use-me';
import type { Project } from '@/lib/collab/types';
import type { RepoListItem } from '@fluent-flow/db';
import { Badge } from '@/components/ui/badge';
import { StartWorkflowDialog } from './start-workflow-dialog';

function StatusBadge({ isActive }: { isActive: boolean | null }) {
  if (isActive === null) {
    return <Badge variant="outline" className="border-yellow-800 bg-yellow-950 text-yellow-400">unknown</Badge>;
  }
  return isActive
    ? <Badge variant="outline" className="border-green-800 bg-green-950 text-green-400">active</Badge>
    : <Badge variant="outline" className="border-red-800 bg-red-950 text-red-400">suspended</Badge>;
}

export function RepoCard({ repo }: { repo: RepoListItem }) {
  const router = useRouter();
  const { me, loading: meLoading, denied: meDenied, reload } = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orgWorkspaces = me?.workspaces.filter((w) => w.orgId === repo.org_id) ?? [];
  const workspace = orgWorkspaces.find((w) => workspaceCapabilitiesFor(me, w.id).includes('project.admin'));
  const unavailable = !me
    ? meLoading
      ? 'Loading workspace access…'
      : meDenied
        ? 'Your workspace access could not be verified. Refresh to check your access.'
        : 'Could not load your workspaces.'
    : orgWorkspaces.length === 0
      ? 'No workspace is available for this organization yet. Try signing in again.'
      : !workspace ? 'A workspace admin can create projects for this repository.' : null;
  const retryAccess = !me && !meLoading;

  async function createProject() {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await collabFetch<Pick<Project, 'id'>>(`/workspaces/${workspace.id}/projects`, {
        method: 'POST',
        body: { name: repo.repo_full_name.split('/').pop(), repoFullName: repo.repo_full_name },
      });
      await reload();
      router.push(`/projects/${result.data.id}`);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 422
        ? 'This repository is no longer available for this workspace. Refresh and try again.'
        : err instanceof ApiError && [403, 404].includes(err.status)
          ? 'You no longer have permission to create a project here. Refresh to check your access.'
          : 'Could not create the project. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <a
              href={`https://github.com/${repo.repo_full_name}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-primary hover:underline"
            >
              {repo.repo_full_name}
            </a>
            <StatusBadge isActive={repo.is_active} />
          </div>
          {repo.active_claims > 0 && (
            <Link
              href="/pipelines"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {repo.active_claims} active claim{repo.active_claims !== 1 ? 's' : ''}
            </Link>
          )}
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={!workspace || busy} onClick={() => void createProject()}>
            {busy ? 'Creating…' : 'Create project'}
          </Button>
          <StartWorkflowDialog repoId={repo.id} repoFullName={repo.repo_full_name} />
        </div>
      </div>
      {unavailable ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {unavailable}
          {retryAccess ? (
            <Button variant="link" size="sm" className="h-auto px-1 text-xs" onClick={() => void reload()}>
              Retry
            </Button>
          ) : null}
        </p>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
